/**
 * blkStocks Shipment Tracking — D1-backed status page.
 *
 * REBUILT 2026-07-14 (TAI-AUDIT.md remediation). This worker previously
 * reverse-proxied every request to TAI's FrontOffice with an authenticated
 * session cookie, which let SMS link-scanners, email gateways, and crawlers
 * generate ~99% of the 500k requests that got the TAI account throttled.
 *
 * It now NEVER contacts TAI. Shipment status is read from bos-app's
 * freight D1 database (binding FREIGHT_DB, read-only by convention — the
 * same cross-binding pattern files-blkstocks-worker uses for TEAM_DB) and
 * rendered as a branded, mobile-first status page, edge-cached 5 minutes.
 *
 * Routes (host-agnostic — serves shipment.trackblkstocks.com and any other
 * bound domain identically):
 *   GET /                      → branded landing page
 *   GET /robots.txt            → User-agent: * / Disallow: /
 *   GET /favicon.ico           → 204
 *   GET /{shipmentId}          → status page (TAI numeric ids + MAN-… manual ids)
 *   GET /FrontOffice[/]        → legacy hash-link shim. Historical links are
 *       /FrontOffice#/trackshipment/{id}; the fragment never reaches the
 *       server, so this serves a tiny page whose inline JS reads
 *       location.hash and redirects to /{id}. All links in the wild keep
 *       resolving.
 *   anything else              → branded 404. Nothing is ever forwarded.
 */

const BRAND = {
  teal: '#2D4A54',
  accent: '#96BDCC',
  offWhite: '#F5F7FA',
  logo: 'https://files-blkstocks.com/brand/bos-logo-light.png',
  phone: '(770) 867-8000',
  phoneHref: '+17708678000',
};

const STAGES = ['Booked', 'Picked Up', 'In Transit', 'Out for Delivery', 'Delivered'];

// ─── Pure helpers (exported for tests) ───

// Path → route descriptor. Shipment ids: TAI numeric (6–12 digits) or the
// manual MAN-{timestamp} shape bos-app's create-manual flow generates.
export function parseRoute(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { type: 'landing' };
  if (path === '/robots.txt') return { type: 'robots' };
  if (path === '/favicon.ico') return { type: 'favicon' };
  if (/^\/FrontOffice$/i.test(path)) return { type: 'shim' };
  const m = path.match(/^\/(\d{6,12}|MAN-\d{8,16})$/i);
  if (m) return { type: 'status', shipmentId: m[1] };
  return { type: 'notfound' };
}

// tai_status string → timeline stage index (0-4), 'canceled', or null (unknown).
export function statusStage(status) {
  const norm = String(status || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!norm) return null;
  if (/(cancel)/.test(norm)) return 'canceled';
  if (/(delivered|complete)/.test(norm)) return 4;
  if (/(outfordelivery|delivering)/.test(norm)) return 3;
  if (/(intransit)/.test(norm)) return 2;
  if (/(pickedup|atpickup|loaded)/.test(norm)) return 1;
  if (/(quoted|booked|committed|ready|scheduled|dispatched|pending)/.test(norm)) return 0;
  return null;
}

// Full stage resolution: the status label wins, but real pickup/delivery
// timestamps can only push the stage FORWARD (a late "Committed" webhook
// must not regress a shipment that has actually picked up).
export function stageForShipment(row) {
  const s = statusStage(row.tai_status);
  if (s === 'canceled') return { canceled: true, index: -1 };
  let idx = typeof s === 'number' ? s : 0;
  if (row.actual_pickup && idx < 1) idx = 1;
  if (row.actual_delivery || s === 4) idx = 4;
  return { canceled: false, index: idx };
}

// "2026-07-15T08:00:00-05:00" / "2026-07-15" → "Jul 15, 2026" (date part
// only — never routed through a local-TZ Date, so the calendar day the
// carrier promised is the day we show).
export function fmtDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mon = months[parseInt(m[2], 10) - 1];
  if (!mon) return null;
  return `${mon} ${parseInt(m[3], 10)}, ${m[1]}`;
}

// Short month-day for the timeline dot annotations: "Jul 13".
export function fmtShortDate(iso) {
  const full = fmtDate(iso);
  return full ? full.replace(/,\s*\d{4}$/, '') : null;
}

// Timestamp → "Jul 14, 1:13 PM ET". D1 stores SQLite datetime('now') UTC
// ("2026-07-14 17:13:38") and TAI sends ISO with offsets — normalize the
// bare-UTC shape, then let ICU render Eastern. Date-only strings (no time
// part) fall back to fmtDate so we never invent a midnight time.
export function fmtDateTimeET(iso) {
  const s = String(iso || '').trim();
  if (!s) return null;
  if (!/\d{2}:\d{2}/.test(s)) return fmtDate(s);
  let normalized = s.replace(' ', 'T');
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(normalized)) normalized += 'Z';
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return fmtDate(s);
  const datePart = d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
  const timePart = d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  return `${datePart}, ${timePart} ET`;
}

// Today's calendar date in US Eastern as "YYYY-MM-DD" — drives the
// "Arriving today" state. en-CA locale renders ISO order.
export function todayET(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// "25000" + "1" → "25,000 lbs / 1 pc" — mirrors bos-app's calendar formatter
// (weight_total / pieces_total are separate D1 columns).
export function fmtWeight(weight, pieces) {
  const parts = [];
  if (weight != null && weight !== '' && Number(weight) > 0) {
    parts.push(`${Number(weight).toLocaleString('en-US')} lbs`);
  }
  if (pieces != null && pieces !== '' && Number(pieces) > 0) {
    const p = Number(pieces);
    parts.push(`${p} ${p === 1 ? 'pc' : 'pcs'}`);
  }
  return parts.length ? parts.join(' / ') : null;
}

// "+14059779873" → "(405) 977-9873" for display; anything non-NANP passes
// through untouched. The tel: href always uses the raw stored value.
export function fmtPhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (ten.length !== 10) return s;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

// ─── HTML rendering ───

function pageShell(title, bodyHtml, { noindex = true } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${noindex ? '<meta name="robots" content="noindex, nofollow">' : ''}
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: ${BRAND.offWhite}; color: #1f2d33; min-height: 100vh;
         display: flex; flex-direction: column; }
  header { background: ${BRAND.teal}; padding: 16px 20px; display: flex; align-items: center; gap: 12px; }
  header img { height: 30px; display: block; }
  header .hd-title { color: #fff; font-size: 14px; font-weight: 500; letter-spacing: 0.04em;
                     text-transform: uppercase; opacity: 0.9; }
  main { flex: 1; width: 100%; max-width: 560px; margin: 0 auto; padding: 20px 16px 40px; }
  .card { background: #fff; border-radius: 14px; box-shadow: 0 2px 10px rgba(45,74,84,0.10);
          padding: 22px 20px; }
  .proj { font-size: 13px; color: #5b7078; margin-bottom: 2px; }
  h1 { font-size: 20px; font-weight: 700; color: ${BRAND.teal}; margin-bottom: 4px; }
  .ship-meta { font-size: 13px; color: #5b7078; margin-bottom: 18px; }
  .status-line { font-size: 16px; font-weight: 700; margin-bottom: 2px; }
  .eta-line { font-size: 14px; color: #3c545d; margin-bottom: 20px; }
  .canceled-badge { display: inline-block; background: #fbeaea; color: #a13030; font-weight: 700;
                    font-size: 13px; border-radius: 8px; padding: 6px 12px; margin-bottom: 18px; }
  .timeline { display: flex; margin: 8px 0 26px; }
  .step { flex: 1; text-align: center; position: relative; }
  .step .dot { width: 16px; height: 16px; border-radius: 50%; margin: 0 auto 7px;
               background: #d7e0e4; border: 3px solid #d7e0e4; position: relative; z-index: 1; }
  .step .bar { position: absolute; top: 7px; left: -50%; width: 100%; height: 3px; background: #d7e0e4; }
  .step:first-child .bar { display: none; }
  .step.done .dot { background: ${BRAND.teal}; border-color: ${BRAND.teal}; }
  .step.done .bar { background: ${BRAND.teal}; }
  .step.current .dot { background: ${BRAND.teal}; border-color: ${BRAND.accent};
                       box-shadow: 0 0 0 4px rgba(150,189,204,0.35); }
  .step .lbl { font-size: 10.5px; line-height: 1.25; color: #7d8f96; font-weight: 500; }
  .step.done .lbl, .step.current .lbl { color: ${BRAND.teal}; font-weight: 700; }
  .step .lbl-date { font-size: 10px; color: #90a1a8; margin-top: 2px; font-weight: 500; }
  .step.done .lbl-date, .step.current .lbl-date { color: #5b7078; }
  .eta-line.eta-today { color: #B45309; font-weight: 700; }
  .details { border-top: 1px solid #e6edf0; }
  .drow { display: flex; justify-content: space-between; gap: 14px; padding: 10px 0;
          border-bottom: 1px solid #eef3f5; font-size: 14px; }
  .drow .k { color: #7d8f96; flex-shrink: 0; }
  .drow .v { text-align: right; font-weight: 500; }
  .drow .v a { color: ${BRAND.teal}; font-weight: 700; text-decoration: none; }
  .drow .v .sub { color: #90a1a8; font-weight: 400; font-size: 12px; }
  .foot-note { font-size: 12px; color: #90a1a8; margin-top: 16px; text-align: center; }
  .contact { margin-top: 22px; text-align: center; font-size: 13px; color: #5b7078; }
  .contact a { color: ${BRAND.teal}; font-weight: 700; text-decoration: none; }
  .nf-icon { font-size: 40px; text-align: center; margin: 8px 0 12px; }
  .nf-text { text-align: center; font-size: 14px; color: #3c545d; line-height: 1.55; }
  .ext-btn { display: block; text-align: center; background: ${BRAND.teal}; color: #fff;
             border-radius: 10px; padding: 12px; font-weight: 700; font-size: 14px;
             text-decoration: none; margin-top: 18px; }
  @media (min-width: 480px) { .step .lbl { font-size: 12px; } h1 { font-size: 22px; } }
</style>
</head>
<body>
<header>
  <img src="${BRAND.logo}" alt="blkStocks">
  <div class="hd-title">Shipment Tracking</div>
</header>
<main>
${bodyHtml}
</main>
</body>
</html>`;
}

function contactHtml() {
  return `<div class="contact">Questions about this shipment? Call blkStocks at
    <a href="tel:${BRAND.phoneHref}">${BRAND.phone}</a></div>`;
}

export function renderStatusPage(row) {
  const stage = stageForShipment(row);
  const delivered = stage.index === 4 && !stage.canceled;

  const etaDate = fmtDate(row.delivery_date);
  const deliveredDate = fmtDate(row.actual_delivery);
  const pickedDate = fmtDate(row.actual_pickup);
  const asOf = fmtDateTimeET(row.last_location_update) || fmtDateTimeET(row.updated_at);

  let statusLine, etaLine = '', etaToday = false;
  if (stage.canceled) {
    statusLine = '';
  } else if (delivered) {
    statusLine = 'Delivered';
    etaLine = deliveredDate ? `Delivered ${deliveredDate}` : '';
  } else {
    statusLine = escapeHtml(row.tai_status || STAGES[stage.index]);
    // Carriers often never report "Out for Delivery" — synthesize the
    // delivery-day signal from the ETA we hold instead of waiting on TAI.
    const dm = String(row.delivery_date || '').match(/^(\d{4}-\d{2}-\d{2})/);
    if (dm && dm[1] === todayET()) {
      etaLine = 'Arriving today';
      etaToday = true;
    } else {
      etaLine = etaDate ? `Estimated delivery ${etaDate}` : '';
    }
  }

  // Per-dot dates: reached stages annotate with the real timestamp we hold
  // (Booked = row creation from the TAI feed, Picked Up / Delivered =
  // carrier actuals). In Transit / Out for Delivery carry no timestamp.
  const stageDates = [
    fmtShortDate(row.created_at),
    fmtShortDate(row.actual_pickup),
    null,
    null,
    delivered ? fmtShortDate(row.actual_delivery || row.delivery_date) : null,
  ];
  const timeline = stage.canceled ? '' : `<div class="timeline">${STAGES.map((label, i) => {
    const cls = i < stage.index ? 'step done' : i === stage.index ? 'step current done' : 'step';
    const dateHtml = (i <= stage.index && stageDates[i]) ? `<div class="lbl-date">${stageDates[i]}</div>` : '';
    return `<div class="${cls}"><div class="bar"></div><div class="dot"></div><div class="lbl">${label}</div>${dateHtml}</div>`;
  }).join('')}</div>`;

  const active = !delivered && !stage.canceled;

  const rows = [];
  if (row.carrier_name) rows.push(['Carrier', escapeHtml(row.carrier_name)]);
  // Driver name + cell only while the shipment is live — after delivery (or
  // cancelation) the assignment is stale and the driver shouldn't get calls.
  if (active && (row.driver_name || row.driver_phone)) {
    const parts = [];
    if (row.driver_name) parts.push(escapeHtml(row.driver_name));
    if (row.driver_phone) {
      const disp = fmtPhone(row.driver_phone);
      parts.push(`<a href="tel:${escapeHtml(String(row.driver_phone).trim())}">${escapeHtml(disp)}</a>`);
    }
    rows.push(['Driver', parts.join('<br>')]);
  }
  const origin = [row.origin_city, row.origin_state].filter(Boolean).join(', ');
  const dest = [row.dest_city, row.dest_state].filter(Boolean).join(', ');
  if (origin) rows.push(['From', escapeHtml(origin)]);
  if (dest) rows.push(['To', escapeHtml(dest)]);
  // Commodity description deliberately NOT shown (Justin 2026-07-21: it's a
  // free-text placeholder typed at booking and usually stale — the weight
  // and piece count are the real data).
  const weightStr = fmtWeight(row.weight_total, row.pieces_total);
  if (weightStr) rows.push(['Weight', escapeHtml(weightStr)]);
  if (pickedDate) rows.push(['Picked up', pickedDate]);
  if (active && row.location_string) {
    const hasCoords = Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude))
      && !(Number(row.latitude) === 0 && Number(row.longitude) === 0)
      && row.latitude != null && row.longitude != null;
    const mapLink = hasCoords
      ? ` &middot; <a href="https://maps.google.com/?q=${Number(row.latitude)},${Number(row.longitude)}" rel="noopener">Map &#8599;</a>`
      : '';
    rows.push(['Last location', escapeHtml(row.location_string) + mapLink
      + (asOf ? `<br><span class="sub">as of ${asOf}</span>` : '')]);
  }
  if (row.po_reference) rows.push(['Reference', escapeHtml(row.po_reference)]);

  const detailsHtml = rows.length
    ? `<div class="details">${rows.map(([k, v]) => `<div class="drow"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('')}</div>`
    : '';

  // Manual shipments carry an external carrier tracking URL — offer it.
  const extLink = (row.source === 'manual' && row.tracking_url && /^https?:\/\//i.test(row.tracking_url))
    ? `<a class="ext-btn" href="${escapeHtml(row.tracking_url)}" rel="noopener">Carrier tracking page &#8599;</a>`
    : '';

  const updated = fmtDateTimeET(row.updated_at);

  const body = `<div class="card">
  ${row.project_name ? `<div class="proj">${escapeHtml(row.project_name)}</div>` : ''}
  <h1>Shipment ${escapeHtml(String(row.tai_shipment_id))}</h1>
  <div class="ship-meta">${row.po_reference ? `PO ${escapeHtml(row.po_reference)}` : '&nbsp;'}</div>
  ${stage.canceled
    ? '<div class="canceled-badge">This shipment was canceled</div>'
    : `<div class="status-line">${statusLine}</div><div class="eta-line${etaToday ? ' eta-today' : ''}">${etaLine || '&nbsp;'}</div>`}
  ${timeline}
  ${detailsHtml}
  ${extLink}
  ${updated ? `<div class="foot-note">Last updated ${updated}</div>` : ''}
</div>
${contactHtml()}`;

  return pageShell(`Shipment ${row.tai_shipment_id} — blkStocks Tracking`, body);
}

export function renderNotFoundPage(shipmentId) {
  const body = `<div class="card">
  <div class="nf-icon">&#128230;</div>
  <h1 style="text-align:center">Shipment not found</h1>
  <div class="nf-text" style="margin-top:10px">
    ${shipmentId ? `We couldn&#39;t find tracking details for shipment <strong>${escapeHtml(shipmentId)}</strong>.` : 'This tracking link doesn&#39;t match an active shipment.'}
    <br>The shipment may not be booked yet, or this link may have expired.
  </div>
</div>
${contactHtml()}`;
  return pageShell('Shipment not found — blkStocks Tracking', body);
}

function renderLandingPage() {
  const body = `<div class="card">
  <h1>blkStocks Shipment Tracking</h1>
  <div class="nf-text" style="text-align:left;margin-top:10px">
    Open the tracking link from your text message or email to see your
    shipment&#39;s live status, carrier, and estimated delivery date.
  </div>
</div>
${contactHtml()}`;
  return pageShell('blkStocks Shipment Tracking', body);
}

// Legacy links look like /FrontOffice#/trackshipment/{id}. The #fragment is
// client-side only, so this page's inline script extracts the id and hops to
// the canonical /{id} route.
function renderShimPage() {
  const script = '<script>(function(){' +
    'var m=(location.hash||"").match(/trackshipment\\/([A-Za-z0-9-]+)/);' +
    'if(m){location.replace("/"+m[1]);}' +
    '})()</script>';
  const body = `<div class="card">
  <h1>Loading shipment&hellip;</h1>
  <div class="nf-text" style="text-align:left;margin-top:10px">
    If nothing happens, your tracking link may be incomplete &mdash; open the
    original link from your text message or email, or call us below.
  </div>
</div>
${contactHtml()}
${script}`;
  return pageShell('blkStocks Shipment Tracking', body);
}

// ─── Data access ───

// Read-only, single indexed lookup. tai_shipment_id has INTEGER affinity for
// TAI ids (SQLite coerces the string binding for comparison) and stores the
// MAN-… manual ids as TEXT — one query serves both.
async function lookupShipment(env, shipmentId) {
  return env.FREIGHT_DB.prepare(`
    SELECT tai_shipment_id, tai_status, delivery_date, actual_pickup, actual_delivery,
           carrier_name, location_string, last_location_update, po_reference,
           origin_city, origin_state, dest_city, dest_state,
           driver_name, driver_phone, latitude, longitude,
           weight_total, pieces_total, created_at,
           project_name, source, tracking_url, updated_at
    FROM freight_shipments WHERE tai_shipment_id = ?
  `).bind(shipmentId).first();
}

// ─── Responses ───

function htmlResponse(html, { status = 200, maxAge = 300 } = {}) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': `public, max-age=${maxAge}`,
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);
    const route = parseRoute(url.pathname);

    switch (route.type) {
      case 'robots':
        return new Response('User-agent: *\nDisallow: /\n', {
          headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=86400' },
        });

      case 'favicon':
        return new Response(null, { status: 204, headers: { 'Cache-Control': 'public, max-age=86400' } });

      case 'landing':
        return htmlResponse(renderLandingPage(), { maxAge: 3600 });

      case 'shim':
        return htmlResponse(renderShimPage(), { maxAge: 3600 });

      case 'status': {
        // Edge cache: 5-min TTL per URL. Collapses SMS-scanner and repeat
        // opens into at most one D1 read per shipment per 5 minutes.
        const cache = typeof caches !== 'undefined' ? caches.default : null;
        const cacheKey = new Request(url.origin + '/' + route.shipmentId, { method: 'GET' });
        if (cache) {
          const hit = await cache.match(cacheKey);
          if (hit) return hit;
        }

        let row = null;
        try {
          row = await lookupShipment(env, route.shipmentId);
        } catch (err) {
          console.error(`[tracking] D1 lookup failed for ${route.shipmentId}: ${err.message}`);
          // Render not-found rather than a 500 — short cache so a transient
          // D1 blip doesn't stick.
          return htmlResponse(renderNotFoundPage(route.shipmentId), { status: 404, maxAge: 60 });
        }

        const resp = row
          ? htmlResponse(renderStatusPage(row), { maxAge: 300 })
          : htmlResponse(renderNotFoundPage(route.shipmentId), { status: 404, maxAge: 300 });

        if (cache && row) {
          ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        }
        return resp;
      }

      default:
        return htmlResponse(renderNotFoundPage(null), { status: 404, maxAge: 3600 });
    }
  },
};
