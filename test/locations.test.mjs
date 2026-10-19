import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker, { renderStatusPage } from '../src/index.js';
import { TrackingLocations, normalizeHistory, coordinate, sourceTime, COOLDOWN_MS, MAX_POINTS } from '../src/locations.js';
import { mapStops, fallbackLocation } from '../src/map-model.js';

const id = '900000001';
const now = Date.parse('2026-10-19T15:00:00Z');
const point = (reportedAt = '2026-10-19T14:44:00Z', location = 'Example, TN', latitude = 35.24, longitude = -85.84) => ({ locationDateTime: reportedAt, locationString: location, latitude, longitude });
const packet = (shipmentId = id, items = [point()]) => ({ shipmentId: Number(shipmentId), shipmentStatus: 'Delivered', estimatedDelivery: '2099-01-01', latitude: 1, longitude: 2, lastLocation: 'Untimed', locationHistory: items, cost: 987654.99 });
const ROW = { tai_shipment_id: Number(id), tai_status: 'In Transit', actual_pickup: '2026-10-18', origin_city: 'Elk Grove Village', origin_state: 'IL', dest_city: 'Winder', dest_state: 'GA', project_name: 'Example project', carrier_name: 'Example carrier', driver_name: 'Example driver', driver_phone: '+12025550123', weight_total: 2425, pieces_total: 2, po_reference: 'EXAMPLE-01', vendor_name: 'Example vendor', location_string: 'Older report', last_location_update: '2026-10-18T15:00:00Z', latitude: 42, longitude: -88, updated_at: '2026-10-19T15:00:00Z', bol_url: 'https://files-blkstocks.com/fixture/BOL.pdf', pod_url: 'https://files-blkstocks.com/fixture/POD.pdf', pod_signed_by: 'PRIVATE BROKER NAME', cost: 987654.99 };

export class MemoryStorage {
  constructor() { this.values = new Map(); this.queue = Promise.resolve(); }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) {
    if (typeof key === 'object') { for (const [k, v] of Object.entries(key)) this.values.set(k, structuredClone(v)); }
    else this.values.set(key, structuredClone(value));
  }
  transaction(fn) { const task = this.queue.then(() => fn(this)); this.queue = task.catch(() => {}); return task; }
}
function objectHarness(fetcher = async url => Response.json(packet(url.split('/').at(-1)))) {
  const storage = new MemoryStorage(); let time = now, calls = 0;
  const env = { TAI_REFRESH_ENABLED: 'true', TAI_API_KEY: 'fixture-key-never-real' };
  const make = () => new TrackingLocations({ storage }, env, { clock: () => time, fetcher: async (...args) => { calls++; return fetcher(...args); } });
  let object = make();
  return { storage, env, advance: ms => { time += ms; }, calls: () => calls, restart: () => { object = make(); }, request: async (shipmentId = id, method = 'POST', final = false) => (await object.fetch(new Request('https://internal/' + shipmentId + (final ? '?final=1' : ''), { method }))).json() };
}
function handlerEnv(row = ROW, object = null) {
  const statements = [], invocations = [];
  return { statements, invocations, TRACKING_LOCATIONS_ENABLED: 'true',
    FREIGHT_DB: { prepare(sql) { statements.push(sql); return { bind: shipmentId => ({ first: async () => String(row?.tai_shipment_id) === shipmentId ? structuredClone(row) : null }) }; } },
    TRACKING_LOCATIONS: { idFromName: name => name, get: () => ({ fetch: async (url, options) => { invocations.push({ url, options }); return object ? object.fetch(new Request(url, options)) : Response.json({ state: 'saved', history: normalizeHistory(packet(), id, now) }); } }) },
  };
}
const request = (path = '/api/locations/' + id, method = 'POST', headers = {}) => new Request('https://tracking.example' + path, { method, headers: { Origin: 'https://tracking.example', 'X-Tracking-Refresh': '1', 'Sec-Fetch-Site': 'same-origin', ...headers } });

test('normalization keeps source time, deduplicates, sorts and strips unrelated fields', () => {
  const result = normalizeHistory(packet(id, [point(), point('2026-10-19T13:00:00-01:00'), point()]), id, now);
  assert.equal(result.points.length, 2); assert.equal(result.points[0].reportedAt, '2026-10-19T14:00:00.000Z');
  assert.equal(result.latest.reportedAt, '2026-10-19T14:44:00.000Z');
  assert.equal(result.checkedAt, '2026-10-19T15:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(result), /987654|Delivered|2099/);
  assert.throws(() => normalizeHistory(packet('900000002'), id, now));
  assert.throws(() => normalizeHistory({ shipmentId: id }, id, now));
});
test('coordinates and timestamps fail closed without dropping useful text', () => {
  for (const [lat, lng] of [[null, null], ['', ''], [false, false], [0, 0], [91, 1], [1, 181], [NaN, 0], ['35', '-85']]) assert.equal(coordinate(lat, lng), null);
  assert.deepEqual(coordinate(0, 10), { latitude: 0, longitude: 10 });
  for (const stamp of ['invalid', '2026-10-19', '2026-10-19T14:00:00', '2027-01-01T00:00:00Z', '2026-02-30T00:00:00Z', '2026-02-28T24:00:00Z']) assert.equal(sourceTime(stamp, now), null);
  const result = normalizeHistory(packet(id, [point(undefined, 'Text-only', null, null)]), id, now);
  assert.equal(result.latest.location, 'Text-only'); assert.equal(result.latest.latitude, undefined);
  assert.throws(() => normalizeHistory(packet(id, [point('invalid')]), id, now));
});
test('empty history never fabricates a source timestamp and older data never regresses the latest', () => {
  const empty = normalizeHistory(packet(id, []), id, now); assert.equal(empty.latest, null); assert.equal(empty.untimed.reportedAt, undefined);
  const first = normalizeHistory(packet(), id, now);
  const older = normalizeHistory(packet(id, [point('2026-10-18T00:00:00Z')]), id, now, first);
  assert.equal(older.latest.reportedAt, first.latest.reportedAt);
  assert.equal(normalizeHistory(packet(id, []), id, now, first).points.length, 1);
  const many = normalizeHistory(packet(id, Array.from({ length: MAX_POINTS + 5 }, (_, i) => point(new Date(now - i * 60_000).toISOString()))), id, now);
  assert.equal(many.points.length, MAX_POINTS); assert.equal(many.truncated, true);
});
test('concurrent visitors share one upstream call and cooldown survives restart', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = objectHarness(async () => { await gate; return Response.json(packet()); });
  const pending = Array.from({ length: 40 }, () => h.request());
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.calls(), 1);
  release(); const results = await Promise.all(pending); assert.equal(results.length, 40); assert.equal(results[0].state, 'refreshed');
  h.restart(); assert.equal((await h.request()).state, 'cooldown'); assert.equal(h.calls(), 1);
  h.advance(COOLDOWN_MS); await h.request(); assert.equal(h.calls(), 2);
});
test('shared rolling-minute and daily caps bound different shipment IDs', async () => {
  const h = objectHarness();
  const responses = await Promise.all(Array.from({ length: 30 }, (_, i) => h.request(String(900000010 + i))));
  assert.equal(h.calls(), 20); assert.equal(responses.filter(r => r.state === 'limited').length, 10);
  h.advance(60_001); await h.request('900000099'); assert.equal(h.calls(), 21);
  const budget = await h.storage.get('budget'); budget.count = 500; await h.storage.put('budget', budget);
  assert.equal((await h.request('900000098')).state, 'limited'); assert.equal(h.calls(), 21);
});
test('429 and auth failures pause globally; failure preserves saved reports', async () => {
  let fail = false;
  const h = objectHarness(async () => fail ? new Response('private upstream body', { status: 429, headers: { 'Retry-After': '3600' } }) : Response.json(packet()));
  await h.request(); h.advance(COOLDOWN_MS); fail = true;
  const result = await h.request(); assert.equal(result.state, 'unavailable'); assert.equal(result.history.points.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private upstream/);
  h.restart(); assert.equal((await h.request('900000002')).state, 'limited'); assert.equal(h.calls(), 2);
  for (const status of [401, 403]) {
    const auth = objectHarness(async () => new Response('', { status }));
    await auth.request(); auth.restart(); await auth.request('900000002'); assert.equal(auth.calls(), 1);
  }
});
test('flags, missing secret and saved reads make zero upstream calls', async () => {
  const h = objectHarness(); await h.request(id, 'GET'); assert.equal(h.calls(), 0);
  h.env.TAI_REFRESH_ENABLED = 'false'; assert.equal((await h.request()).state, 'paused');
  h.env.TAI_REFRESH_ENABLED = 'true'; delete h.env.TAI_API_KEY; await h.request(); assert.equal(h.calls(), 0);
});
test('delivered shipments get one final successful snapshot; failed final can retry', async () => {
  const h = objectHarness(); await h.request(id, 'POST', true); h.advance(COOLDOWN_MS * 2); h.restart();
  assert.equal((await h.request(id, 'POST', true)).state, 'final'); assert.equal(h.calls(), 1);
  let success = false;
  const retry = objectHarness(async () => success ? Response.json(packet()) : new Response('', { status: 503 }));
  assert.equal((await retry.request(id, 'POST', true)).state, 'unavailable');
  retry.advance(COOLDOWN_MS); success = true;
  assert.equal((await retry.request(id, 'POST', true)).state, 'final'); assert.equal(retry.calls(), 2);
  const pendingFinal = objectHarness(async () => Response.json(packet(id, [])));
  assert.equal((await pendingFinal.request(id, 'POST', true)).state, 'refreshed');
  pendingFinal.advance(COOLDOWN_MS); await pendingFinal.request(id, 'POST', true); assert.equal(pendingFinal.calls(), 2);
  const lagging = objectHarness(async () => Response.json({ ...packet(), shipmentStatus: 'In Transit' }));
  assert.equal((await lagging.request(id, 'POST', true)).state, 'refreshed');
});
test('malformed, mismatched and oversized responses retain history and back off', async () => {
  for (const response of [Response.json(packet('900000002')), new Response('not json'), new Response('x', { headers: { 'Content-Length': '3000000' } })]) {
    const h = objectHarness(async () => response);
    assert.equal((await h.request()).state, 'unavailable'); assert.equal((await h.request()).state, 'unavailable'); assert.equal(h.calls(), 1);
  }
});
test('upstream endpoint and secret stay server-side with redirects blocked', async () => {
  const h = objectHarness(async (url, options) => {
    assert.equal(url, 'https://www.taicloud.net/PublicApi/Location/v2/ShipmentLocationHistory/' + id);
    assert.equal(options.redirect, 'manual'); assert.equal(options.headers['x-api-key'], 'fixture-key-never-real');
    return Response.json(packet());
  });
  const result = await h.request(); assert.doesNotMatch(JSON.stringify(result), /fixture-key/);
});
test('an upstream timeout aborts the request and releases waiting visitors', async () => {
  const h = objectHarness(async (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
  const result = await h.request(); assert.equal(result.state, 'unavailable'); assert.equal(h.calls(), 1);
  assert.equal((await h.request()).state, 'unavailable'); assert.equal(h.calls(), 1);
});
test('page GET/HEAD, bot navigation and saved API read never request an upstream refresh', async () => {
  const env = handlerEnv();
  for (const method of ['GET', 'HEAD']) assert.equal((await worker.fetch(request('/' + id, method), env, {})).status, 200);
  assert.equal(env.invocations.length, 0);
  await worker.fetch(request(undefined, 'GET'), env, {}); assert.equal(env.invocations[0].options.method, 'GET');
  assert.ok(env.statements.every(sql => /^\s*SELECT/.test(sql))); assert.equal(ROW.tai_status, 'In Transit');
});
test('refresh rejects cross-origin, missing headers, unknown IDs and unsupported methods', async () => {
  const env = handlerEnv();
  for (const headers of [{ Origin: 'https://evil.example' }, { 'X-Tracking-Refresh': '' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await worker.fetch(request(undefined, 'POST', headers), env, {})).status, 403);
  assert.equal((await worker.fetch(request('/api/locations/900000002'), env, {})).status, 404);
  assert.equal((await worker.fetch(request(undefined, 'HEAD'), env, {})).status, 405);
  assert.equal(env.invocations.length, 0);
  env.TRACKING_LOCATIONS_ENABLED = 'false'; assert.equal((await worker.fetch(request(), env, {})).status, 404);
});
test('manual and canceled shipments never refresh; delivered uses final mode', async () => {
  const manual = handlerEnv({ ...ROW, source: 'manual' }); await worker.fetch(request(), manual, {}); assert.equal(manual.invocations.length, 0);
  const canceled = handlerEnv({ ...ROW, tai_status: 'Canceled' }); await worker.fetch(request(), canceled, {}); assert.equal(canceled.invocations[0].options.method, 'GET');
  const delivered = handlerEnv({ ...ROW, tai_status: 'Delivered' }); await worker.fetch(request(), delivered, {}); assert.match(delivered.invocations[0].url, /final=1/);
});
test('location refresh cannot mutate or leak shipment status, dates, documents, driver or cost', async () => {
  const original = structuredClone(ROW), env = handlerEnv();
  const response = await worker.fetch(request(), env, {}); assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.text(); assert.doesNotMatch(body, /Delivered|2099|987654|Example driver|BOL.pdf/);
  assert.deepEqual(ROW, original); assert.ok(env.statements.every(sql => !/UPDATE|INSERT|DELETE|REPLACE/i.test(sql.replaceAll('last_location_update', '').replaceAll('updated_at', ''))));
});
test('approved layout preserves all existing content and emitted scripts parse safely', () => {
  const html = renderStatusPage({ ...ROW, location_string: '</script><script>evil()</script>' }, { locationsEnabled: true });
  for (const value of ['Example project', 'Example vendor', 'EXAMPLE-01', 'Example carrier', 'Example driver', '2425', 'Proof of Delivery', 'Bill of Lading', 'id="docmodal"', 'id="docmodal-dl"', 'Carrier']) {
    if (value === '2425') assert.match(html, /2,425/); else assert.ok(html.includes(value), value);
  }
  assert.ok(html.indexOf('class="timeline"') < html.indexOf('id="tracking-workspace"'));
  assert.doesNotMatch(html, /PRIVATE BROKER NAME|987654|<script>evil/);
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (!match[0].startsWith('<script type="application/json"')) new vm.Script(match[1]);
  }
  const data = JSON.parse(html.match(/id="journey-data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.fallback.location, '</script><script>evil()</script>'); assert.equal(data.refreshable, true);
});
test('map centers are explicitly approximate and fallback never uses database updated_at as report time', () => {
  const stops = mapStops(ROW); assert.ok(stops.every(p => p.approximate && p.xy));
  assert.equal(fallbackLocation({ ...ROW, last_location_update: null }).reportedAt, null);
  assert.ok(mapStops({ origin_city: 'not a city', origin_state: 'XX' }).every(p => !p.xy));
});


test('staged activation keeps the existing card while the bounded API is verifiable', async () => {
  const env = handlerEnv();
  env.TRACKING_LOCATIONS_UI_ENABLED = 'false';
  const staged = await worker.fetch(request('/' + id, 'GET'), env, {});
  assert.doesNotMatch(await staged.text(), /id="tracking-workspace"/);
  assert.equal(env.invocations.length, 0);
  assert.equal((await worker.fetch(request(), env, {})).status, 200);
  assert.equal(env.invocations.length, 1);
  env.TRACKING_LOCATIONS_UI_ENABLED = 'true';
  const enabled = await worker.fetch(request('/' + id, 'GET'), env, {});
  assert.match(await enabled.text(), /id="tracking-workspace"/);
});
