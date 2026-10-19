// Location-only storage. This module never writes FREIGHT_DB or forwards payloads
// to the full-shipment webhook. Ordinary page GETs never invoke refresh().
export const COOLDOWN_MS = 15 * 60_000;
export const MAX_POINTS = 2000;
const MAX_BYTES = 2 * 1024 * 1024;
const text = value => typeof value === 'string' ? value.trim().slice(0, 240) : '';

export function coordinate(latitude, longitude) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number' ||
      !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180 ||
      (latitude === 0 && longitude === 0)) return null;
  return { latitude, longitude };
}

export function sourceTime(value, now = Date.now()) {
  if (typeof value !== 'string') return null;
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 && ms <= now + 5 * 60_000 ? new Date(ms).toISOString() : null;
}

export function normalizeHistory(payload, shipmentId, now = Date.now(), previous = null) {
  if (!payload || Array.isArray(payload) || String(payload.shipmentId) !== String(shipmentId) || !Array.isArray(payload.locationHistory)) {
    throw new Error('Invalid location response');
  }
  const points = new Map();
  for (const p of previous?.points || []) points.set(JSON.stringify(p), p);
  let rejected = 0;
  for (const item of payload.locationHistory) {
    if (!item || typeof item !== 'object') { rejected++; continue; }
    const reportedAt = sourceTime(item.locationDateTime, now);
    const coords = coordinate(item.latitude, item.longitude);
    const location = text(item.locationString);
    if (!reportedAt || (!coords && !location)) { rejected++; continue; }
    const point = { reportedAt, location, ...(coords || {}) };
    points.set(JSON.stringify(point), point);
  }
  // Malformed nonempty payloads must not be presented as a successful empty feed.
  if (payload.locationHistory.length && rejected === payload.locationHistory.length) throw new Error('No valid location reports');
  const ordered = [...points.values()].sort((a, b) => a.reportedAt.localeCompare(b.reportedAt));
  const latest = ordered.at(-1) || null;
  // The top-level position has NO source timestamp. Never borrow the fetch time
  // or attach it to a different history observation.
  const untimed = !latest ? { location: text(payload.lastLocation), ...(coordinate(payload.latitude, payload.longitude) || {}) } : null;
  return {
    points: ordered.slice(-MAX_POINTS), latest,
    untimed: untimed && (untimed.location || untimed.latitude != null) ? untimed : null,
    truncated: !!previous?.truncated || ordered.length > MAX_POINTS,
    rejected, checkedAt: new Date(now).toISOString(),
  };
}

export function locationJson(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff',
  } });
}

function snapshot(record, state, now, extra = {}) {
  return { state, history: record?.history || null,
    nextCheckAt: record?.nextAttempt > now ? new Date(record.nextAttempt).toISOString() : null, ...extra };
}

function retryDelay(response, now) {
  const raw = response.headers.get('Retry-After');
  const delay = raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw || '') - now;
  return Number.isFinite(delay) ? Math.max(60_000, Math.min(delay, 24 * 60 * 60_000)) : 5 * 60_000;
}

async function boundedJson(response) {
  if (Number(response.headers.get('Content-Length')) > MAX_BYTES) throw new Error('Location response too large');
  if (!response.body) throw new Error('Missing location response');
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Location response too large'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder().decode(body));
}

// A single named object coordinates every shipment. Persistent transactional
// reservations bound API traffic across visitors, isolates, and object restarts.
// fetcher/clock are injectable only from tests, never request-controlled.
export class TrackingLocations {
  // Native Workers fetch must keep its global receiver, not the Durable Object.
  constructor(ctx, env, { fetcher = (url, options) => fetch(url, options), clock = Date.now } = {}) {
    this.ctx = ctx; this.env = env; this.fetcher = fetcher; this.clock = clock;
    this.inflight = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const id = url.pathname.slice(1);
    if (!/^[1-9]\d{5,9}$/.test(id) || Number(id) > 2147483647) return locationJson({ state: 'unavailable' }, 400);
    if (request.method === 'GET') {
      const record = await this.ctx.storage.get('shipment:' + id);
      return locationJson(snapshot(record, record?.lastState || 'saved', this.clock()));
    }
    if (request.method !== 'POST') return locationJson({ state: 'unavailable' }, 405);
    const final = url.searchParams.get('final') === '1';
    const task = this.inflight.get(id) || this.refresh(id, final);
    this.inflight.set(id, task);
    try { return locationJson(await task); }
    finally { if (this.inflight.get(id) === task) this.inflight.delete(id); }
  }

  async refresh(id, final) {
    const now = this.clock();
    const key = 'shipment:' + id;
    const reservation = await this.ctx.storage.transaction(async tx => {
      const record = await tx.get(key) || {};
      if (this.env.TAI_REFRESH_ENABLED !== 'true' || !this.env.TAI_API_KEY) return { result: snapshot(record, 'paused', now) };
      if (final && record.finalized) return { result: snapshot(record, 'final', now) };
      if (record.nextAttempt > now) return { result: snapshot(record, record.lastState === 'unavailable' ? 'unavailable' : 'cooldown', now) };
      const budget = await tx.get('budget') || { recent: [], day: '', count: 0 };
      const day = new Date(now).toISOString().slice(0, 10);
      if (budget.day !== day) { budget.day = day; budget.count = 0; }
      budget.recent = budget.recent.filter(at => at > now - 60_000);
      // Deliberately below TAI's account ceiling. These caps cover this worker,
      // not other integrations sharing TAI credentials or an outbound IP.
      if (budget.blockedUntil > now || budget.recent.length >= 20 || budget.count >= 500) {
        const next = Math.max(budget.blockedUntil || 0, budget.count >= 500 ? Date.parse(day) + 86400_000 : (budget.recent[0] || now) + 60_000);
        return { result: snapshot(record, 'limited', now, { nextCheckAt: new Date(next).toISOString() }) };
      }
      budget.recent.push(now); budget.count++;
      record.nextAttempt = now + COOLDOWN_MS;
      await tx.put({ budget, [key]: record });
      return { record };
    });
    if (reservation.result) return reservation.result;
    const record = reservation.record;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let failureStage = 'fetch', providerStatus = null;
    try {
      const response = await this.fetcher('https://www.taicloud.net/PublicApi/Location/v2/ShipmentLocationHistory/' + id, {
        method: 'GET', headers: { accept: 'application/json', 'x-api-key': this.env.TAI_API_KEY },
        signal: controller.signal, redirect: 'manual',
      });
      providerStatus = response.status; failureStage = 'provider-status';
      if (!response.ok) {
        if ([401, 403, 429].includes(response.status)) {
          const delay = response.status === 429 ? retryDelay(response, now) : 60 * 60_000;
          await this.ctx.storage.transaction(async tx => {
            const budget = await tx.get('budget');
            budget.blockedUntil = Math.max(budget.blockedUntil || 0, now + delay);
            await tx.put('budget', budget);
          });
        }
        await response.body?.cancel();
        throw new Error('Location provider unavailable');
      }
      failureStage = 'response-parse';
      const payload = await boundedJson(response);
      failureStage = 'normalization';
      record.history = normalizeHistory(payload, id, this.clock(), record.history);
      record.failures = 0; record.lastState = 'saved';
      // Do not freeze an empty or still-in-transit provider snapshot when the
      // status webhook reached us first. This affects refresh policy only;
      // the public status and dates remain exclusively D1's.
      record.finalized = final && record.history.points.length > 0 && /^(delivered|complete|completed)$/i.test(String(payload.shipmentStatus || '').trim());
      failureStage = 'storage';
      await this.ctx.storage.put(key, record);
      return snapshot(record, record.finalized ? 'final' : 'refreshed', this.clock());
    } catch {
      // Operational diagnosis only: never log credentials, response bodies or locations.
      console.warn('[tracking] location refresh failed', { stage: failureStage, providerStatus });
      record.failures = Math.min((record.failures || 0) + 1, 8);
      record.nextAttempt = now + Math.min(6 * 60 * 60_000, COOLDOWN_MS * 2 ** (record.failures - 1));
      record.lastState = 'unavailable';
      await this.ctx.storage.put(key, record);
      return snapshot(record, 'unavailable', this.clock());
    } finally { clearTimeout(timeout); }
  }
}
