import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Miniflare, createFetchMock } from 'miniflare';

test('native Workers fetch retrieves and freezes history through a real Durable Object', async () => {
  const mock = createFetchMock();
  mock.disableNetConnect();
  const reportedAt = new Date(Date.now() - 60000).toISOString();
  mock.get('https://www.taicloud.net').intercept({
    path: '/PublicApi/Location/v2/ShipmentLocationHistory/900000001',
    method: 'GET', headers: { 'x-api-key': 'fixture-only' },
  }).reply(200, JSON.stringify({ shipmentId: 900000001, shipmentStatus: 'Delivered', locationHistory: [
    { locationDateTime: reportedAt, latitude: 35.2, longitude: -85.8, locationString: 'Example report' },
  ] }), { headers: { 'content-type': 'application/json' } });
  const source = await fs.readFile(new URL('../src/locations.js', import.meta.url), 'utf8');
  const mf = new Miniflare({ compatibilityDate: '2024-12-01', fetchMock: mock,
    bindings: { TAI_REFRESH_ENABLED: 'true', TAI_API_KEY: 'fixture-only' },
    durableObjects: { TRACKING_LOCATIONS: { className: 'TrackingLocations', useSQLite: true } },
    modules: [
      { type: 'ESModule', path: 'index.mjs', contents: `import {TrackingLocations} from './locations.mjs'; export {TrackingLocations}; export default { async fetch(request, env) { const object = env.TRACKING_LOCATIONS.get(env.TRACKING_LOCATIONS.idFromName('fixture')); return object.fetch('https://locations.internal/900000001?final=1', {method: request.method}); } };` },
      { type: 'ESModule', path: 'locations.mjs', contents: source },
    ],
  });
  try {
    const result = await (await mf.dispatchFetch('http://unit.test', { method: 'POST' })).json();
    assert.equal(result.state, 'final');
    assert.equal(result.history.points.length, 1);
    assert.equal(result.history.latest.reportedAt, reportedAt);
    const again = await (await mf.dispatchFetch('http://unit.test', { method: 'POST' })).json();
    assert.equal(again.state, 'final');
    assert.deepEqual(again.history, result.history);
    mock.assertNoPendingInterceptors();
  } finally { await mf.dispose(); await mock.close(); }
});

test('native Workers fetch rejects provider redirects without contacting the destination', async () => {
  const requests = [];
  const source = await fs.readFile(new URL('../src/locations.js', import.meta.url), 'utf8');
  // Return the redirect directly to workerd. Miniflare's fetchMock bridge uses
  // a Node fetch that follows redirects before workerd can inspect them.
  const mf = new Miniflare({ compatibilityDate: '2024-12-01',
    outboundService: async request => {
      requests.push(request.url);
      if (new URL(request.url).hostname === 'www.taicloud.net') return new Response(null, { status: 302, headers: { location: 'https://untrusted.example/redirect' } });
      return Response.json({});
    },
    bindings: { TAI_REFRESH_ENABLED: 'true', TAI_API_KEY: 'fixture-only' },
    durableObjects: { TRACKING_LOCATIONS: { className: 'TrackingLocations', useSQLite: true } },
    modules: [
      { type: 'ESModule', path: 'index.mjs', contents: `import {TrackingLocations} from './locations.mjs'; export {TrackingLocations}; export default { async fetch(request, env) { return env.TRACKING_LOCATIONS.get(env.TRACKING_LOCATIONS.idFromName('fixture')).fetch('https://locations.internal/900000001', {method:'POST'}); } };` },
      { type: 'ESModule', path: 'locations.mjs', contents: source },
    ],
  });
  try {
    const result = await (await mf.dispatchFetch('http://unit.test')).json();
    assert.equal(result.state, 'unavailable');
    assert.equal(result.history, null);
    assert.deepEqual(requests, ['https://www.taicloud.net/PublicApi/Location/v2/ShipmentLocationHistory/900000001']);
  } finally { await mf.dispose(); }
});
