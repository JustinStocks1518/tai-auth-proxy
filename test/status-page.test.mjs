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
  fmtDateTimeET,
  todayET,
  fmtPhone,
  fmtWeight,
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
  n += 6;
};

await run();
console.log(`\n${n} fixtures passed`);
