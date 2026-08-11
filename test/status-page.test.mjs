// Status-page fixtures — run: node test/status-page.test.mjs
//
// Load-bearing assertions: every historical URL shape resolves; nothing is
// ever proxied (unknown paths 404 locally); no cost field can render (the
// SELECT never includes one, and the fixture row carries a canary the page
// must not print).
import assert from 'node:assert/strict';
import worker, {
  parseRoute,
  statusStage,
  stageForShipment,
  fmtDate,
  fmtShortDate,
  fmtClock,
  parseStops,
  fmtDateTimeET,
  todayET,
  fmtPhone,
  fmtWeight,
  docThumbSrc,
  escapeHtml,
  renderStatusPage,
  renderNotFoundPage,
} from '../src/index.js';

let n = 0;
function t(name, fn) { fn(); n += 1; console.log(`  ok ${name}`); }

// ── parseRoute: every historical URL shape ─────────────────────────────

t('bare shipment id (track.blkstocks.com/{id} legacy Make links + canonical)', () => {
  assert.deepEqual(parseRoute('/130152017'), { type: 'status', shipmentId: '130152017' });
  assert.deepEqual(parseRoute('/127209205'), { type: 'status', shipmentId: '127209205' });
});

t('manual MAN- ids resolve', () => {
  assert.equal(parseRoute('/MAN-1748012345678').type, 'status');
  assert.equal(parseRoute('/man-1748012345678').type, 'status'); // case-tolerant
});

t('/FrontOffice serves the hash shim (fragment never reaches the server)', () => {
  assert.equal(parseRoute('/FrontOffice').type, 'shim');
  assert.equal(parseRoute('/FrontOffice/').type, 'shim');
  assert.equal(parseRoute('/frontoffice').type, 'shim');
});

t('robots, favicon, landing', () => {
  assert.equal(parseRoute('/robots.txt').type, 'robots');
  assert.equal(parseRoute('/favicon.ico').type, 'favicon');
  assert.equal(parseRoute('/').type, 'landing');
});

t('everything else 404s locally — no proxying, ever', () => {
  for (const p of ['/wp-admin', '/Account/LoginAjax', '/Files/SecureDownload',
    '/FrontOffice/api/whatever', '/130152017/extra', '/abc', '/.env']) {
    assert.equal(parseRoute(p).type, 'notfound', p);
  }
});

t('id shape bounds: too short / too long are not shipment routes', () => {
  assert.equal(parseRoute('/12345').type, 'notfound');
  assert.equal(parseRoute('/1234567890123').type, 'notfound');
});

// ── status → stage mapping ──────────────────────────────────────────────

t('observed D1 statuses map to stages', () => {
  assert.equal(statusStage('Committed'), 0);
  assert.equal(statusStage('Ready'), 0);
  assert.equal(statusStage('In Transit'), 2);
  assert.equal(statusStage('In-Transit'), 2); // TAI hyphen variant
  assert.equal(statusStage('Out for Delivery'), 3);
  assert.equal(statusStage('Delivered'), 4);
  assert.equal(statusStage('Canceled'), 'canceled');
  assert.equal(statusStage('Something New'), null);
  assert.equal(statusStage(null), null);
});

t('actual timestamps only push the stage FORWARD', () => {
  // Late "Committed" webhook must not regress a picked-up shipment
  assert.equal(stageForShipment({ tai_status: 'Committed', actual_pickup: '2026-07-13T08:00:00Z' }).index, 1);
  // actual_delivery wins regardless of label
  assert.equal(stageForShipment({ tai_status: 'In Transit', actual_delivery: '2026-07-14' }).index, 4);
  // Delivered label without timestamps still lands on Delivered
  assert.equal(stageForShipment({ tai_status: 'Delivered' }).index, 4);
  assert.equal(stageForShipment({ tai_status: 'Canceled' }).canceled, true);
});

// ── date formatting (no TZ drift — date part only) ──────────────────────

t('fmtDate keeps the carrier-promised calendar day', () => {
  assert.equal(fmtDate('2026-07-15T08:00:00-05:00'), 'Jul 15, 2026');
  assert.equal(fmtDate('2026-06-01'), 'Jun 1, 2026');
  assert.equal(fmtDate('2026-07-14 17:13:38'), 'Jul 14, 2026');
  assert.equal(fmtDate('garbage'), null);
  assert.equal(fmtDate(null), null);
});

t('fmtShortDate drops the year for dot annotations', () => {
  assert.equal(fmtShortDate('2026-07-13T08:36:00-04:00'), 'Jul 13');
  assert.equal(fmtShortDate(null), null);
});

t('fmtDateTimeET renders Eastern time; bare SQLite datetimes are UTC', () => {
  assert.equal(fmtDateTimeET('2026-07-14 17:13:38'), 'Jul 14, 1:13 PM ET'); // EDT = UTC-4
  assert.equal(fmtDateTimeET('2026-07-14T09:06:31Z'), 'Jul 14, 5:06 AM ET');
  assert.equal(fmtDateTimeET('2026-06-01'), 'Jun 1, 2026'); // date-only → no invented time
  assert.equal(fmtDateTimeET(null), null);
});

t('todayET returns an ISO calendar date', () => {
  assert.match(todayET(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(todayET(new Date('2026-07-22T02:00:00Z')), '2026-07-21'); // 10 PM ET the day before
});

t('escapeHtml neutralizes markup from D1 strings', () => {
  assert.equal(escapeHtml('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
});

t('fmtPhone formats NANP numbers, passes anything else through', () => {
  assert.equal(fmtPhone('+14059779873'), '(405) 977-9873');
  assert.equal(fmtPhone('4059779873'), '(405) 977-9873');
  assert.equal(fmtPhone('+447911123456'), '+447911123456'); // non-NANP untouched
  assert.equal(fmtPhone(''), null);
  assert.equal(fmtPhone(null), null);
});

t('fmtWeight mirrors the calendar formatter', () => {
  assert.equal(fmtWeight(25000, 1), '25,000 lbs / 1 pc');
  assert.equal(fmtWeight(655, 3), '655 lbs / 3 pcs');
  assert.equal(fmtWeight(655, null), '655 lbs');
  assert.equal(fmtWeight(null, 2), '2 pcs');
  assert.equal(fmtWeight(0, 0), null);
  assert.equal(fmtWeight(null, null), null);
});

// ── render fixtures ─────────────────────────────────────────────────────

const ROW = {
  tai_shipment_id: 130152017,
  tai_status: 'In Transit',
  delivery_date: '2026-07-15T08:00:00-05:00',
  actual_pickup: '2026-07-13T08:36:00-04:00',
  actual_delivery: null,
  carrier_name: 'MSM EXPRESS INC',
  location_string: 'S Frost Rd  Livingston, LA 70754',
  last_location_update: '2026-07-14T09:06:31Z',
  po_reference: '70148-131',
  origin_city: 'KALAMAZOO', origin_state: 'MI',
  dest_city: 'PRAIRIEVILLE', dest_state: 'LA',
  project_name: 'Allstar Ford Prairieville Truck Center Annex',
  source: 'tai', tracking_url: null,
  updated_at: '2026-07-14 17:13:38',
  created_at: '2026-07-12 14:00:00',
  driver_name: 'Charles',
  driver_phone: '+14059779873',
  latitude: 30.478966, longitude: -90.746858,
  // canaries: even if a future SELECT leaks them, the renderer must not
  // print them (cost policy; commodity dropped 2026-07-21 — stale free-text)
  commodity_description: 'RACKING',
  freight_cost: 987654.99,
  weight_total: 25000, pieces_total: 1,
};

t('status page renders the spec fields and nothing costly', () => {
  const html = renderStatusPage(ROW);
  assert.match(html, /MSM EXPRESS INC/);
  assert.match(html, /Estimated delivery Jul 15, 2026/);
  assert.match(html, /Livingston, LA/);
  assert.match(html, /70148-131/);
  assert.match(html, /Last updated Jul 14, 1:13 PM ET/);
  assert.match(html, /In Transit/);
  assert.doesNotMatch(html, /987654|987,654|freight_cost/);
});

t('commodity description never renders (stale free-text; weight is the data)', () => {
  const html = renderStatusPage(ROW);
  assert.doesNotMatch(html, /RACKING|Contents/);
  assert.match(html, /25,000 lbs \/ 1 pc/);
});

t('active shipment shows driver name + tel link, weight, map link', () => {
  const html = renderStatusPage(ROW);
  assert.match(html, /Charles/);
  assert.match(html, /href="tel:\+14059779873"/);
  assert.match(html, /\(405\) 977-9873/);
  assert.match(html, /25,000 lbs \/ 1 pc/);
  assert.match(html, /maps\.google\.com\/\?q=30\.478966,-90\.746858/);
});

// TAI stop actuals — measured present on 100% of delivered loads, vs 68% for
// GPS location. Times carry the STOP's own offset and must render as that
// dock's wall clock, never converted.
const STOPS = JSON.stringify([
  { stopType: 'First Pickup', companyName: 'WHIP', city: 'FORT WORTH', state: 'TX',
    actualArrivalDateTime: '2026-08-05T09:51:00-05:00', actualDepartureDateTime: '2026-08-05T12:01:00-05:00' },
  { stopType: 'Last Drop', companyName: 'ALLSTAR', city: 'PRAIRIEVILLE', state: 'LA',
    actualArrivalDateTime: '2026-08-06T07:21:00-05:00', actualDepartureDateTime: '2026-08-06T08:41:00-05:00' },
]);

t('fmtClock reads the wall clock off the string, no TZ conversion', () => {
  assert.equal(fmtClock('2026-08-06T07:21:00-05:00'), '7:21 AM');
  assert.equal(fmtClock('2026-08-06T19:05:00-04:00'), '7:05 PM'); // offset ignored on purpose
  assert.equal(fmtClock('2026-08-06T00:30:00Z'), '12:30 AM');
  assert.equal(fmtClock('2026-08-06'), null);
  assert.equal(fmtClock(null), null);
});

t('parseStops picks the bookend stops and their actuals', () => {
  const s = parseStops(STOPS);
  assert.equal(s.pickup.date, 'Aug 5');
  assert.equal(s.pickup.time, '9:51 AM');
  assert.equal(s.pickup.departed, '12:01 PM');
  assert.equal(s.drop.date, 'Aug 6');
  assert.equal(s.drop.time, '7:21 AM');
  // multi-stop: First Pickup / Last Drop win over array order
  const three = JSON.parse(STOPS);
  three.splice(1, 0, { stopType: 'Drop', actualArrivalDateTime: '2026-08-05T18:00:00-05:00' });
  assert.equal(parseStops(JSON.stringify(three)).drop.time, '7:21 AM');
  // garbage never throws
  assert.deepEqual(parseStops('not json'), { pickup: null, drop: null });
  assert.deepEqual(parseStops(null), { pickup: null, drop: null });
  // a stop with no actual arrival yields null, not a half-built object
  assert.equal(parseStops(JSON.stringify([{ stopType: 'First Pickup' }])).pickup, null);
});

t('timeline shows stop clock times; pickup row shows the dock window', () => {
  const html = renderStatusPage({ ...ROW, stops: STOPS, tai_status: 'Delivered', actual_delivery: '2026-08-06' });
  assert.match(html, /Picked Up<\/div><div class="lbl-date">Aug 5<br><span class="lbl-time">9:51 AM/);
  assert.match(html, /Delivered<\/div><div class="lbl-date">Aug 6<br><span class="lbl-time">7:21 AM/);
  assert.match(html, /9:51 AM &ndash; 12:01 PM/); // dock window on the detail row
});

t('no stop actuals → falls back to shipment dates, no empty time span', () => {
  const html = renderStatusPage(ROW); // ROW has no stops
  assert.match(html, /<div class="lbl">Picked Up<\/div><div class="lbl-date">Jul 13<\/div>/);
  // match the MARKUP — the class name is always present in the CSS
  assert.doesNotMatch(html, /<span class="lbl-time">/);
});

t('pod_signed_by is NEVER shown — it is our broker, not the consignee', () => {
  // Measured 51/51 "Shane Scully" (Camel's rep keying the POD into TAI).
  // Rendering it would tell a customer our own broker signed for their
  // freight. Captured in D1, deliberately not surfaced.
  const html = renderStatusPage({
    ...ROW, pod_url: 'https://files-blkstocks.com/freight-docs/1/POD-x.jpg', pod_signed_by: 'Shane Scully',
  });
  assert.doesNotMatch(html, /Shane Scully/);
  assert.doesNotMatch(html, /Signed by/i);
  assert.match(html, /Tap to view/);
});

t('timeline dots annotate reached stages with their dates', () => {
  const html = renderStatusPage(ROW); // In Transit: Booked + Picked Up reached
  assert.match(html, /<div class="lbl">Booked<\/div><div class="lbl-date">Jul 12<\/div>/);
  assert.match(html, /<div class="lbl">Picked Up<\/div><div class="lbl-date">Jul 13<\/div>/);
  assert.doesNotMatch(html, /<div class="lbl">Delivered<\/div><div class="lbl-date">/);
  const done = renderStatusPage({ ...ROW, tai_status: 'Delivered', actual_delivery: '2026-07-14T13:12:00-05:00' });
  assert.match(done, /<div class="lbl">Delivered<\/div><div class="lbl-date">Jul 14<\/div>/);
});

t('ETA today renders the highlighted Arriving-today state', () => {
  const html = renderStatusPage({ ...ROW, delivery_date: todayET() });
  assert.match(html, /class="eta-line eta-today">Arriving today</);
  const notToday = renderStatusPage(ROW);
  assert.doesNotMatch(notToday, /Arriving today/);
  const done = renderStatusPage({ ...ROW, delivery_date: todayET(), tai_status: 'Delivered', actual_delivery: todayET() });
  assert.doesNotMatch(done, /Arriving today/); // delivered wins
});

t('BOL/POD links render only from our own public bucket', () => {
  const both = renderStatusPage({ ...ROW, bol_url: 'https://files-blkstocks.com/freight-docs/130152017/BOL-bol.pdf', pod_url: 'https://files-blkstocks.com/freight-docs/130152017/POD-9e0d.pdf' });
  assert.match(both, /Bill of Lading/);
  assert.match(both, /Proof of Delivery/);
  assert.match(both, /freight-docs\/130152017\/BOL-bol\.pdf/);
  const none = renderStatusPage(ROW);
  assert.doesNotMatch(none, /Bill of Lading|Proof of Delivery/);
  // A poisoned D1 value pointing off-domain must not become a link
  const evil = renderStatusPage({ ...ROW, pod_url: 'https://evil.example/x.pdf' });
  assert.doesNotMatch(evil, /evil\.example/);
});

t('docs live in their own panel, not as a detail row', () => {
  const html = renderStatusPage({ ...ROW, pod_url: 'https://files-blkstocks.com/freight-docs/1/POD-x.jpg' });
  assert.match(html, /class="docs-section"/);
  assert.match(html, /Shipping Documents/);
  assert.match(html, /class="doc-tile doc-view"/);
  // must NOT be one of the k/v rows anymore
  assert.doesNotMatch(html, /<span class="k">Proof of Delivery<\/span>/);
  // no empty panel (match the MARKUP — the class name is always in the CSS)
  assert.doesNotMatch(renderStatusPage(ROW), /<section class="docs-section"/);
});

t('image docs thumbnail via the CF transform; PDFs use the generated one', () => {
  const img = renderStatusPage({ ...ROW, pod_url: 'https://files-blkstocks.com/freight-docs/1/POD-x.jpg' });
  assert.match(img, /cdn-cgi\/image\/width=400[^"]*\/freight-docs\/1\/POD-x\.jpg/);
  const pdf = renderStatusPage({
    ...ROW,
    pod_url: 'https://files-blkstocks.com/freight-docs/1/POD-x.pdf',
    pod_thumb_url: 'https://files-blkstocks.com/layout-derived/abc-thumb.jpg',
  });
  assert.match(pdf, /cdn-cgi\/image\/width=400[^"]*\/layout-derived\/abc-thumb\.jpg/);
  // PDF with no generated thumb yet → type chip, never a broken <img>
  const pending = renderStatusPage({ ...ROW, pod_url: 'https://files-blkstocks.com/freight-docs/1/POD-x.pdf' });
  assert.match(pending, /doc-chip/);
  assert.doesNotMatch(pending, /<img src="[^"]*freight-docs\/1\/POD-x\.pdf/);
});

t('docThumbSrc refuses anything not on our bucket', () => {
  assert.equal(docThumbSrc('https://evil.example/x.jpg', null), null);
  assert.equal(docThumbSrc('https://files-blkstocks.com/a/b.pdf', 'https://evil.example/t.jpg'), null);
  assert.equal(docThumbSrc(null, null), null);
});

t('doc modal ships only when a doc exists; carries viewer + download', () => {
  const withDoc = renderStatusPage({ ...ROW, pod_url: 'https://files-blkstocks.com/freight-docs/130152017/POD-9e0d.pdf' });
  assert.match(withDoc, /id="docmodal"/);
  assert.match(withDoc, /doc-view/);
  assert.match(withDoc, /data-doc-label="Proof of Delivery"/);
  assert.match(withDoc, /id="docmodal-dl"/); // download button
  assert.match(withDoc, /createObjectURL/);  // blob download path
  const none = renderStatusPage(ROW);
  assert.doesNotMatch(none, /id="docmodal"/); // no dead modal on doc-less pages
});

t('missing driver / coords degrade gracefully', () => {
  const html = renderStatusPage({ ...ROW, driver_name: null, driver_phone: null, latitude: null, longitude: null });
  assert.doesNotMatch(html, /Driver/);
  assert.doesNotMatch(html, /maps\.google\.com/);
  assert.match(html, /Livingston, LA/); // location string still renders
});

t('delivered shipment says Delivered with the actual date', () => {
  const html = renderStatusPage({ ...ROW, tai_status: 'Delivered', actual_delivery: '2026-07-14T13:12:00-05:00' });
  assert.match(html, /Delivered Jul 14, 2026/);
  // last-known-location + driver contact suppressed once delivered
  assert.doesNotMatch(html, /Last location/);
  assert.doesNotMatch(html, /tel:\+14059779873/);
});

t('canceled shipment renders the badge, no timeline', () => {
  const html = renderStatusPage({ ...ROW, tai_status: 'Canceled' });
  assert.match(html, /canceled/i);
  assert.doesNotMatch(html, /class="timeline"/);
});

t('manual shipment with external tracking_url offers the carrier link', () => {
  const html = renderStatusPage({ ...ROW, source: 'manual', tracking_url: 'https://www.aaacooper.com/x?p=1' });
  assert.match(html, /aaacooper\.com/);
});

t('not-found page carries the contact line', () => {
  const html = renderNotFoundPage('000000');
  assert.match(html, /Shipment not found/);
  assert.match(html, /770/); // office phone
});

// ── end-to-end through the fetch handler (stubbed D1, no caches in Node) ─

const env = {
  FREIGHT_DB: {
    prepare: () => ({
      bind: (id) => ({
        first: async () => (String(id) === '130152017' ? ROW : null),
      }),
    }),
  },
};
const ctx = { waitUntil() {} };
const get = (path) => worker.fetch(new Request(`https://shipment.trackblkstocks.com${path}`), env, ctx);

const run = async () => {
  {
    const r = await get('/130152017');
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /MSM EXPRESS INC/);
    assert.match(r.headers.get('Cache-Control'), /max-age=300/);
    console.log('  ok GET /{knownId} → 200 with 5-min cache header');
  }
  {
    const r = await get('/999999999');
    assert.equal(r.status, 404);
    assert.match(await r.text(), /Shipment not found/);
    console.log('  ok GET /{unknownId} → 404 not-found page');
  }
  {
    // A query fault must NOT read as "your shipment doesn't exist" (the
    // 2026-08-11 column-lag incident) and must not be cached.
    const brokenEnv = { FREIGHT_DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('no such column: pod_signed_by'); } }) }) } };
    const r = await worker.fetch(new Request('https://shipment.trackblkstocks.com/130152017'), brokenEnv, ctx);
    assert.equal(r.status, 503);
    const html = await r.text();
    assert.match(html, /temporarily unavailable/i);
    assert.doesNotMatch(html, /not found/i);
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
    console.log('  ok D1 fault → 503 "temporarily unavailable", never cached, never "not found"');
  }
  {
    const r = await get('/robots.txt');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Disallow: \//);
    console.log('  ok GET /robots.txt → Disallow all');
  }
  {
    const r = await get('/FrontOffice');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /trackshipment/);
    console.log('  ok GET /FrontOffice → hash shim (legacy links resolve)');
  }
  {
    const r = await get('/wp-admin');
    assert.equal(r.status, 404);
    console.log('  ok GET /wp-admin → local 404 (nothing forwarded)');
  }
  {
    const r = await worker.fetch(new Request('https://shipment.trackblkstocks.com/130152017', { method: 'POST' }), env, ctx);
    assert.equal(r.status, 405);
    console.log('  ok POST → 405');
  }
  n += 7;
};

await run();
console.log(`\n${n} fixtures passed`);
