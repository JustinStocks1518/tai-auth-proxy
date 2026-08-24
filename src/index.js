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

// FOUR stages, not five. "Out for Delivery" was dropped 2026-08-24: TAI has
// sent exactly four statuses across every shipment we have ever received
// (Delivered, Committed, In Transit, Canceled) — that one has never arrived
// once, so the dot could never light up, never be the current stage, and
// never carry a time. It filled in retroactively on delivered loads and sat
// grey on live ones. The customer portal's delivery rail already drops it.
// Every remaining stage can carry a real timestamp.
export const STAGES = ['Booked', 'Picked Up', 'In Transit', 'Delivered'];
const STAGE_DELIVERED = 3;

// The app's success green (brand + Field Schedule status colours).
const GREEN = '#16A34A';

const CHECK_SVG ='<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

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
  if (/(delivered|complete)/.test(norm)) return STAGE_DELIVERED;
  // Kept mapping even though TAI has never sent it: if that status ever does
  // arrive it means MOVING, not arrived — it must not fill the Delivered dot.
  if (/(outfordelivery|delivering)/.test(norm)) return 2;
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
  if (row.actual_delivery || s === STAGE_DELIVERED) idx = STAGE_DELIVERED;
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

// "2026-08-06T07:21:00-05:00" → "7:21 AM".
// Read straight off the string, never through a Date: TAI stamps stop times
// with the STOP's own offset, so the wall clock in the string is the local
// time at that dock — which is what a reader means by "arrived 7:21".
// Converting to any single zone would be wrong for half the country.
export function fmtClock(iso) {
  const m = String(iso || '').match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ampm}`;
}

// TAI ships a `stops` array on every shipment (measured: 100% of delivered
// loads carry actual arrival/departure times — including every load that
// never produced a GPS ping). That makes stop times the reliable spine of
// the timeline; `location_string` is the sporadic extra.
// Multi-stop loads use First Pickup / Last Drop as the bookends, with
// plain Pick/Drop in between.
export function parseStops(stopsJson) {
  let stops;
  try {
    stops = typeof stopsJson === 'string' ? JSON.parse(stopsJson) : stopsJson;
  } catch { return { pickup: null, drop: null }; }
  if (!Array.isArray(stops) || !stops.length) return { pickup: null, drop: null };
  const pick = (t) => stops.find((s) => String(s?.stopType || '').toLowerCase() === t);
  const first = pick('first pickup') || stops[0];
  const last = pick('last drop') || stops[stops.length - 1];
  const shape = (s) => (s && s.actualArrivalDateTime ? {
    date: fmtShortDate(s.actualArrivalDateTime),
    time: fmtClock(s.actualArrivalDateTime),
    departed: fmtClock(s.actualDepartureDateTime),
  } : null);
  return { pickup: shape(first), drop: shape(last) };
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

// Only our own public bucket is ever linked or embedded.
const R2_DOC_RE = /^https:\/\/files-blkstocks\.com\/(.+)$/;
const IMAGE_DOC_RE = /\.(jpe?g|png|gif|webp|heic)(\?|$)/i;

// Thumbnail source for a document tile, or null when there's nothing to show
// (renders a type chip instead).
//   images — no generation anywhere: Cloudflare's image transform resizes the
//     R2 object straight from its own URL.
//   PDFs — bos-app pre-renders a page-1 JPG (CloudConvert) into R2 and stores
//     the URL on the shipment row; absent until that lands.
// Either way the result is re-served through the transform at tile size.
export function docThumbSrc(docUrl, storedThumbUrl) {
  const src = IMAGE_DOC_RE.test(String(docUrl || '')) ? docUrl : storedThumbUrl;
  const m = String(src || '').match(R2_DOC_RE);
  if (!m) return null;
  return `https://files-blkstocks.com/cdn-cgi/image/width=400,quality=70,format=jpeg,fit=scale-down,metadata=none/${m[1]}`;
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
  .vendor { font-size: 15px; font-weight: 600; color: #3c545d; margin-bottom: 6px; }
  .ship-meta { font-size: 12.5px; color: #7d8f96; margin-bottom: 20px; }
  .status-line { font-size: 17px; font-weight: 700; margin-bottom: 2px;
                 display: flex; align-items: center; gap: 8px; }
  .status-check { width: 20px; height: 20px; border-radius: 50%; background: ${GREEN};
                  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .status-check svg { width: 12px; height: 12px; }
  .eta-line { font-size: 14px; color: #3c545d; margin-bottom: 20px; }
  .eta-line.eta-indent { padding-left: 28px; }
  .canceled-badge { display: inline-block; background: #fbeaea; color: #a13030; font-weight: 700;
                    font-size: 13px; border-radius: 8px; padding: 6px 12px; margin-bottom: 18px; }
  .timeline { display: flex; margin: 8px 0 26px; }
  .step { flex: 1; text-align: center; position: relative; }
  .step .dot { width: 18px; height: 18px; border-radius: 50%; margin: 0 auto 8px;
               background: #d7e0e4; border: 3px solid #d7e0e4; position: relative; z-index: 1; }
  /* bar sits on the dot's centre line: (18 − 3) / 2 = 7.5 */
  .step .bar { position: absolute; top: 7.5px; left: -50%; width: 100%; height: 3px; background: #d7e0e4; }
  .step:first-child .bar { display: none; }
  .step.done .dot { background: ${BRAND.teal}; border-color: ${BRAND.teal}; }
  .step.done .bar { background: ${BRAND.teal}; }
  .step.current .dot { background: ${BRAND.teal}; border-color: ${BRAND.accent};
                       box-shadow: 0 0 0 4px rgba(150,189,204,0.35); }
  /* Three deliberate weights: stage label (700 once reached) > date (600) >
     time (500). The stamps were getting lost at 10/9.5px — bumped, but kept
     a step below the label so the timeline still reads label-first. */
  .step .lbl { font-size: 12px; line-height: 1.25; color: #7d8f96; font-weight: 600; }
  .step.done .lbl, .step.current .lbl { color: ${BRAND.teal}; font-weight: 700; }
  .step .lbl-date { font-size: 11.5px; color: #8397a0; margin-top: 3px; font-weight: 600; line-height: 1.35; }
  .step.done .lbl-date, .step.current .lbl-date { color: #4a5f68; }
  .step .lbl-time { font-size: 11px; color: #7d8f96; font-weight: 500; }
  /* A reached stage the carrier never clocked, and the not-yet estimate on
     the final dot — both quieter than a real recorded time. */
  .step .lbl-date.lbl-none, .step .lbl-date.lbl-est { color: #a9bcc4; font-weight: 500; }
  /* Delivered: the one green moment on the page. */
  .step-delivered .dot-check { width: 22px; height: 22px; margin-bottom: 6px; background: ${GREEN};
                              border: none; display: flex; align-items: center; justify-content: center;
                              box-shadow: 0 0 0 4px rgba(22,163,74,0.18); }
  .step-delivered .dot-check svg { width: 13px; height: 13px; }
  .step-delivered .bar { background: ${GREEN} !important; }
  .step-delivered .lbl { color: #15803d !important; }
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
  /* Shipping documents panel — deliberately set apart from the detail rows:
     these are the records people actually came for. */
  .docs-section { border-top: 1px solid #e6edf0; margin-top: 4px; padding-top: 16px; }
  .docs-head { font-size: 11px; font-weight: 700; letter-spacing: 0.07em;
               text-transform: uppercase; color: #7d8f96; margin-bottom: 12px; }
  .docs-grid { display: flex; flex-wrap: wrap; gap: 14px; }
  .doc-tile { width: 148px; text-decoration: none; display: block; }
  .doc-thumb { width: 148px; height: 116px; border-radius: 10px; overflow: hidden;
               background: #eef2f4; border: 1px solid #dde5e9; display: flex;
               align-items: center; justify-content: center; position: relative;
               transition: box-shadow .15s, border-color .15s; }
  .doc-tile:hover .doc-thumb { border-color: ${BRAND.accent}; box-shadow: 0 3px 12px rgba(45,74,84,0.16); }
  .doc-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .doc-chip { font-size: 11px; font-weight: 700; letter-spacing: .06em; color: #7d8f96; }
  .doc-chip .doc-chip-glyph { font-size: 26px; display: block; margin-bottom: 4px; }
  /* display:block matters — these are <span>s inside the tile's <a>, so
     without it the label and sub-line share one inline flow and wrap into
     each other mid-phrase. */
  .doc-label { display: block; font-size: 12.5px; font-weight: 700; color: ${BRAND.teal};
               margin-top: 7px; line-height: 1.25; }
  .doc-sub { display: block; font-size: 11.5px; color: #7d8f96; margin-top: 1px; }

  /* Shipping-document modal (POD/BOL viewer) */
  .docmodal-overlay { position: fixed; inset: 0; background: rgba(31,45,51,0.74); display: none;
                      align-items: center; justify-content: center; z-index: 50; padding: 16px; }
  .docmodal-overlay.open { display: flex; }
  .docmodal { background: #fff; border-radius: 14px; width: 100%; max-width: 720px; max-height: 92vh;
              display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 12px 40px rgba(0,0,0,0.35); }
  .docmodal-head { background: ${BRAND.teal}; color: #fff; padding: 12px 16px; display: flex;
                   align-items: center; gap: 10px; }
  .docmodal-head img { height: 20px; display: block; }
  .docmodal-title { font-size: 14px; font-weight: 700; flex: 1; min-width: 0; overflow: hidden;
                    text-overflow: ellipsis; white-space: nowrap; }
  .docmodal-close { background: none; border: none; color: #fff; font-size: 24px; cursor: pointer;
                    line-height: 1; padding: 0 4px; font-family: inherit; }
  .docmodal-body { flex: 1; overflow: auto; background: #e9eef1; display: flex;
                   align-items: flex-start; justify-content: center; min-height: 200px; }
  .docmodal-body img { max-width: 100%; height: auto; display: block; }
  .docmodal-body iframe { width: 100%; height: 72vh; border: none; background: #fff; }
  .docmodal-foot { padding: 12px 16px; display: flex; gap: 10px; align-items: center;
                   border-top: 1px solid #e6edf0; }
  .docmodal-newtab { color: #5b7078; font-size: 13px; text-decoration: none; font-weight: 600;
                     margin-right: auto; }
  .docmodal-dl { background: ${BRAND.teal}; color: #fff; border-radius: 9px; padding: 10px 18px;
                 font-weight: 700; font-size: 13px; border: none; cursor: pointer; font-family: inherit; }
  .nf-icon { font-size: 40px; text-align: center; margin: 8px 0 12px; }
  .nf-text { text-align: center; font-size: 14px; color: #3c545d; line-height: 1.55; }
  .ext-btn { display: block; text-align: center; background: ${BRAND.teal}; color: #fff;
             border-radius: 10px; padding: 12px; font-weight: 700; font-size: 14px;
             text-decoration: none; margin-top: 18px; }
  @media (min-width: 480px) { .step .lbl { font-size: 13px; } h1 { font-size: 22px; } }
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
  const delivered = stage.index === STAGE_DELIVERED && !stage.canceled;

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

  // Per-dot stamps. Pickup/Delivered prefer the STOP actuals (present on
  // every load, with a real clock time) and fall back to the shipment-level
  // actual_* dates. In Transit / Out for Delivery carry no timestamp.
  // A stamp for every stage that has one:
  //   Booked      — when the shipment first reached us
  //   Picked Up   — arrival at the pickup dock (57% of loads)
  //   In Transit  — DEPARTURE from that dock, i.e. when the truck actually
  //                 rolled (59%). Data TAI has always sent and we never showed.
  //   Delivered   — arrival at the drop (100%)
  // A reached stage with no carrier-reported time shows an em-dash rather
  // than nothing: it happened, the carrier just never reported the clock.
  const stops = parseStops(row.stops);
  const inTransitStamp = stops.pickup?.departed
    ? { date: stops.pickup.date, time: stops.pickup.departed }
    : null;
  const stageStamps = [
    { date: fmtShortDate(row.created_at), time: null },
    stops.pickup || { date: fmtShortDate(row.actual_pickup), time: null },
    inTransitStamp,
    delivered
      ? (stops.drop || { date: fmtShortDate(row.actual_delivery || row.delivery_date), time: null })
      : { date: etaDate ? `Est. ${fmtShortDate(row.delivery_date)}` : null, time: null, est: true },
  ];
  const timeline = stage.canceled ? '' : `<div class="timeline">${STAGES.map((label, i) => {
    const reached = i <= stage.index;
    const isDelivered = i === STAGE_DELIVERED && delivered;
    const cls = [
      i < stage.index ? 'step done' : i === stage.index ? 'step current done' : 'step',
      isDelivered ? 'step-delivered' : '',
    ].filter(Boolean).join(' ');
    const s = stageStamps[i];
    // The estimate on an undelivered final dot is the one stamp shown for a
    // stage that has NOT been reached — it is a promise, not a record.
    const show = s && s.date && (reached || s.est);
    const stampHtml = show
      ? `<div class="lbl-date${s.est ? ' lbl-est' : ''}">${escapeHtml(s.date)}${s.time ? `<br><span class="lbl-time">${escapeHtml(s.time)}</span>` : ''}</div>`
      : (reached ? '<div class="lbl-date lbl-none">&mdash;</div>' : '');
    const dotHtml = isDelivered
      ? `<div class="dot dot-check">${CHECK_SVG}</div>`
      : '<div class="dot"></div>';
    return `<div class="${cls}"><div class="bar"></div>${dotHtml}<div class="lbl">${label}</div>${stampHtml}</div>`;
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
  // Pickup row carries the dock window when TAI gave us both stamps —
  // "Aug 5, 9:51 AM – 12:01 PM" reads as real freight movement.
  if (stops.pickup?.date) {
    const p = stops.pickup;
    let win = escapeHtml(p.date);
    if (p.time) win += `, ${escapeHtml(p.time)}`;
    if (p.time && p.departed && p.departed !== p.time) win += ` &ndash; ${escapeHtml(p.departed)}`;
    rows.push(['Picked up', win]);
  } else if (pickedDate) {
    rows.push(['Picked up', pickedDate]);
  }
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
  // Ref# now leads the header — repeating it as a detail row is noise.

  // Shipping documents get their own panel below the detail rows (Justin,
  // 2026-08-11: as a data row the POD "just blended in with everything
  // else"). Public R2 copies written by bos-app's freight sync; rate quotes
  // are never mirrored here.
  const bolOk = row.bol_url && R2_DOC_RE.test(row.bol_url);
  const podOk = row.pod_url && R2_DOC_RE.test(row.pod_url);
  const docs = [];
  // NOT shown: pod_signed_by. It reads like the consignee's signature but
  // measured 51/51 "Shane Scully" — Camel's rep, i.e. whoever keyed the POD
  // into TAI, not who received the freight. Surfacing it would tell a
  // customer their delivery was signed for by our broker. The column is
  // still captured (see freight/index.js) purely so this stays documented
  // and nobody rediscovers the field and re-adds it.
  if (podOk) docs.push({ url: row.pod_url, thumb: row.pod_thumb_url, label: 'Proof of Delivery' });
  if (bolOk) docs.push({ url: row.bol_url, thumb: row.bol_thumb_url, label: 'Bill of Lading' });

  const docsHtml = docs.length ? `<section class="docs-section">
    <div class="docs-head">Shipping Documents</div>
    <div class="docs-grid">${docs.map((d) => {
      const thumb = docThumbSrc(d.url, d.thumb);
      const ext = (String(d.url).match(/\.([a-z0-9]+)(?:\?|$)/i)?.[1] || 'file').toUpperCase();
      const inner = thumb
        ? `<img src="${escapeHtml(thumb)}" alt="${escapeHtml(d.label)}" loading="lazy">`
        : `<span class="doc-chip"><span class="doc-chip-glyph">&#128196;</span>${escapeHtml(ext)}</span>`;
      return `<a class="doc-tile doc-view" href="${escapeHtml(d.url)}"
          data-doc-url="${escapeHtml(d.url)}" data-doc-label="${escapeHtml(d.label)}"
          target="_blank" rel="noopener">
          <span class="doc-thumb">${inner}</span>
          <span class="doc-label">${escapeHtml(d.label)}</span>
          <span class="doc-sub">Tap to view &middot; ${escapeHtml(ext)}</span>
        </a>`;
    }).join('')}</div>
  </section>` : '';

  const detailsHtml = rows.length
    ? `<div class="details">${rows.map(([k, v]) => `<div class="drow"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('')}</div>`
    : '';

  // Manual shipments carry an external carrier tracking URL — offer it.
  const extLink = (row.source === 'manual' && row.tracking_url && /^https?:\/\//i.test(row.tracking_url))
    ? `<a class="ext-btn" href="${escapeHtml(row.tracking_url)}" rel="noopener">Carrier tracking page &#8599;</a>`
    : '';

  // `updated_at` is when TAI last sent us anything about this shipment —
  // verified against live data: the median gap between the delivery itself
  // and that last webhook is 0.0h, so it tracks real events rather than
  // drifting on re-pings (and no backfill job touches it).
  //
  // On a DELIVERED shipment it is redundant at best and unsettling at worst:
  // sitting a minute after the delivery time it adds nothing, and on the
  // occasional load where TAI pings days later it implies something changed
  // when nothing did. The delivery stamp is the last word there, so the note
  // is only shown while a shipment is still moving — where "how fresh is
  // this?" is a real question — and says plainly what it refers to.
  const updated = fmtDateTimeET(row.updated_at);
  const updatedNote = (!delivered && !stage.canceled && updated)
    ? `<div class="foot-note">Tracking updated ${updated}</div>`
    : '';

  // In-page branded viewer for POD/BOL. Media elements are built via DOM
  // (never innerHTML of the URL) and the download runs fetch→blob so the
  // cross-origin files-blkstocks.com file saves instead of navigating.
  const docModal = (bolOk || podOk) ? `<div class="docmodal-overlay" id="docmodal">
  <div class="docmodal" role="dialog" aria-modal="true" aria-labelledby="docmodal-title">
    <div class="docmodal-head">
      <img src="${BRAND.logo}" alt="">
      <div class="docmodal-title" id="docmodal-title"></div>
      <button class="docmodal-close" id="docmodal-close" aria-label="Close">&times;</button>
    </div>
    <div class="docmodal-body" id="docmodal-body"></div>
    <div class="docmodal-foot">
      <a class="docmodal-newtab" id="docmodal-newtab" target="_blank" rel="noopener">Open in new tab &#8599;</a>
      <button class="docmodal-dl" id="docmodal-dl">Download</button>
    </div>
  </div>
</div>
<script>(function(){
  var ov = document.getElementById('docmodal');
  var bodyEl = document.getElementById('docmodal-body');
  var titleEl = document.getElementById('docmodal-title');
  var newtab = document.getElementById('docmodal-newtab');
  var current = null;
  function openDoc(url, label){
    current = url;
    titleEl.textContent = label + ' \\u2014 Shipment ${escapeHtml(String(row.tai_shipment_id))}';
    bodyEl.textContent = '';
    var media;
    if (/\\.(jpe?g|png|gif|webp)$/i.test(url)) {
      media = document.createElement('img');
      media.alt = label;
    } else {
      media = document.createElement('iframe');
      media.title = label;
    }
    media.src = url;
    bodyEl.appendChild(media);
    newtab.href = url;
    ov.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeDoc(){
    ov.classList.remove('open');
    bodyEl.textContent = '';
    document.body.style.overflow = '';
    current = null;
  }
  document.addEventListener('click', function(e){
    var a = e.target.closest ? e.target.closest('.doc-view') : null;
    if (a) { e.preventDefault(); openDoc(a.getAttribute('data-doc-url'), a.getAttribute('data-doc-label')); return; }
    if (e.target === ov) closeDoc();
  });
  document.getElementById('docmodal-close').addEventListener('click', closeDoc);
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeDoc(); });
  document.getElementById('docmodal-dl').addEventListener('click', function(){
    if (!current) return;
    var name = current.split('/').pop() || 'document';
    fetch(current).then(function(r){ if (!r.ok) throw 0; return r.blob(); }).then(function(b){
      var u = URL.createObjectURL(b);
      var a = document.createElement('a');
      a.href = u; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function(){ URL.revokeObjectURL(u); }, 4000);
    }).catch(function(){ window.open(current, '_blank'); });
  });
})()</script>` : '';

  // Hierarchy (Justin, 2026-08-24): the customer recognises the JOB first and
  // what is on the truck second; the shipment number is a lookup key, so it
  // drops to the meta line. "PO" is our word for it — the customer sees Ref#.
  const vendor = String(row.vendor_name || '').trim();
  const metaBits = [];
  if (row.po_reference) metaBits.push(`Ref# ${escapeHtml(row.po_reference)}`);
  metaBits.push(`Shipment ${escapeHtml(String(row.tai_shipment_id))}`);
  const headerHtml = row.project_name
    ? `<h1>${escapeHtml(row.project_name)}</h1>
  ${vendor ? `<div class="vendor">${escapeHtml(vendor)}</div>` : ''}
  <div class="ship-meta">${metaBits.join(' &nbsp;&middot;&nbsp; ')}</div>`
    // No project on the row (unmatched shipment): fall back to the old shape
    // rather than leading with a blank line.
    : `<h1>Shipment ${escapeHtml(String(row.tai_shipment_id))}</h1>
  <div class="ship-meta">${row.po_reference ? `Ref# ${escapeHtml(row.po_reference)}` : '&nbsp;'}</div>`;

  const body = `<div class="card">
  ${headerHtml}
  ${stage.canceled
    ? '<div class="canceled-badge">This shipment was canceled</div>'
    : `<div class="status-line${delivered ? ' status-delivered' : ''}">${delivered ? `<span class="status-check">${CHECK_SVG}</span>` : ''}${statusLine}</div><div class="eta-line${etaToday ? ' eta-today' : ''}${delivered ? ' eta-indent' : ''}">${etaLine || '&nbsp;'}</div>`}
  ${timeline}
  ${detailsHtml}
  ${docsHtml}
  ${extLink}
  ${updatedNote}
</div>
${contactHtml()}
${docModal}`;

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

// A lookup FAILURE is not a missing shipment. Telling someone holding a live
// tracking link that their freight "doesn't exist" is alarming and wrong —
// proven 2026-08-11, when a column-add lagged its deploy by a minute and an
// in-transit load read as not-found. Say what's true: we couldn't reach the
// data right now.
export function renderUnavailablePage(shipmentId) {
  const body = `<div class="card">
  <div class="nf-icon">&#9203;</div>
  <h1 style="text-align:center">Tracking temporarily unavailable</h1>
  <div class="nf-text" style="margin-top:10px">
    We couldn&#39;t load tracking details${shipmentId ? ` for shipment <strong>${escapeHtml(shipmentId)}</strong>` : ''} right now.
    <br>This is on our end &mdash; the shipment is unaffected. Please refresh in a moment.
  </div>
</div>
${contactHtml()}`;
  return pageShell('Tracking temporarily unavailable — blkStocks', body);
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
           weight_total, pieces_total, created_at, bol_url, pod_url,
           bol_thumb_url, pod_thumb_url, stops, pod_signed_by, vendor_name,
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
      // maxAge 0 means "never hold this" (transient faults), not "hold it
      // for zero seconds and revalidate" — a shared cache treats those
      // differently, and a stuck error page is the failure we're avoiding.
      'Cache-Control': maxAge > 0 ? `public, max-age=${maxAge}` : 'no-store',
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
          // 503 + no-store: a query fault must never read as "your shipment
          // doesn't exist", and must never be cached — the next request
          // should get the real answer the moment the fault clears.
          return htmlResponse(renderUnavailablePage(route.shipmentId), { status: 503, maxAge: 0 });
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
