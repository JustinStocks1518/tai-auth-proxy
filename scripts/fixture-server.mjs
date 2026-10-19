// Real worker and real browser scripts, all data and outbound I/O stubbed locally.
import http from 'node:http';
import worker from '../src/index.js';
import { TrackingLocations } from '../src/locations.js';

class Storage {
  constructor() { this.values = new Map(); this.queue = Promise.resolve(); }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { if (typeof key === 'object') { for (const [k, v] of Object.entries(key)) this.values.set(k, structuredClone(v)); } else this.values.set(key, structuredClone(value)); }
  transaction(fn) { const promise = this.queue.then(() => fn(this)); this.queue = promise.catch(() => {}); return promise; }
}
const locations = [[42.01, -87.99, 'Elk Grove Village, IL'], [40.42, -86.88, 'Lafayette, IN'], [39.77, -86.15, 'Indianapolis, IN'], [38.22, -85.75, 'Louisville, KY'], [36.97, -86.44, 'Bowling Green, KY'], [36.17, -86.78, 'Nashville, TN'], [35.85, -86.39, 'Murfreesboro, TN'], [35.48, -86.09, 'Manchester, TN'], [35.24, -85.84, 'Monteagle, TN']];
const started = Date.now();
const dataFor = id => ({ shipmentId: Number(id), shipmentStatus: id === '900000002' ? 'Delivered' : 'In Transit', locationHistory: (id === '900000004' ? [] : locations).map(([latitude, longitude, locationString], index) => ({ latitude, longitude, locationString, locationDateTime: new Date(started - (id === '900000003' ? 86400_000 : 16 * 60_000) - (locations.length - index - 1) * 90 * 60_000).toISOString() })) });
const objects = new TrackingLocations({ storage: new Storage() }, { TAI_REFRESH_ENABLED: 'true', TAI_API_KEY: 'fixture-only' }, { fetcher: async url => {
  await new Promise(resolve => setTimeout(resolve, 650));
  const id = url.split('/').at(-1);
  return id === '900000005' ? new Response('', { status: 503 }) : Response.json(dataFor(id));
} });
const rows = Object.fromEntries(Array.from({ length: 6 }, (_, i) => {
  const id = String(900000001 + i), delivered = i === 1;
  return [id, { tai_shipment_id: Number(id), project_name: 'Example customer · Atlanta distribution center', vendor_name: 'Example Equipment Co.', po_reference: 'DEMO-01', tai_status: delivered ? 'Delivered' : 'In Transit', actual_pickup: '2026-10-18', actual_delivery: delivered ? '2026-10-19' : null, created_at: '2026-10-17', delivery_date: '2026-10-19', carrier_name: 'Example Transport', driver_name: 'Example Driver', driver_phone: '+12025550123', weight_total: 2425, pieces_total: 2, origin_city: 'Elk Grove Village', origin_state: 'IL', dest_city: 'Winder', dest_state: 'GA', location_string: i === 3 ? null : 'Elk Grove Village, IL', latitude: i === 3 ? null : 42.01, longitude: i === 3 ? null : -87.99, last_location_update: new Date(started - 86400_000).toISOString(), updated_at: new Date(started).toISOString(), bol_url: 'https://files-blkstocks.com/fixture/BOL.svg', pod_url: delivered ? 'https://files-blkstocks.com/fixture/POD.svg' : null, source: i === 5 ? 'manual' : 'tai', tracking_url: i === 5 ? 'https://carrier.example/track' : null }];
}));
const env = { TRACKING_LOCATIONS_ENABLED: 'true', FREIGHT_DB: { prepare: () => ({ bind: id => ({ first: async () => rows[id] || null }) }) }, TRACKING_LOCATIONS: { idFromName: id => id, get: () => ({ fetch: (url, options) => objects.fetch(new Request(url, options)) }) } };
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1:18918');
    if (url.pathname === '/preview') {
      const width = Math.max(320, Math.min(1200, Number(url.searchParams.get('width')) || 390));
      const id = rows[url.searchParams.get('id')] ? url.searchParams.get('id') : '900000001';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><html><head><title>Tracking build preview</title><style>body{margin:0;background:#dce3e6;font-family:system-ui}nav{padding:12px}iframe{display:block;border:0;width:' + width + 'px;max-width:100%;height:1100px;margin:auto;color-scheme:' + (url.searchParams.get('dark') === '1' ? 'dark' : 'light') + '}</style></head><body><nav>Local build preview · synthetic shipment data</nav><iframe title="Shipment preview" src="/' + id + '?build=' + started + '&theme=' + (url.searchParams.get('dark') === '1' ? 'dark' : 'light') + '"></iframe></body></html>'); return;
    }
    const response = await worker.fetch(new Request(url, { method: req.method, headers: req.headers }), env, { waitUntil() {} });
    let body = await response.text();
    if (response.headers.get('Content-Type')?.includes('text/html')) {
      const doc = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="780"><rect width="600" height="780" fill="white"/><text x="50" y="80" font-size="28">Example shipping document</text><text x="50" y="130" font-size="16">Synthetic fixture - no customer information</text></svg>';
      // All external image/document/font requests are replaced in the fixture
      // response; shipped production source retains the original document viewer.
      body = body.replaceAll('https://files-blkstocks.com/fixture/BOL.svg', 'data:image/svg+xml;base64,' + Buffer.from(doc).toString('base64')).replaceAll('https://files-blkstocks.com/fixture/POD.svg', 'data:image/svg+xml;base64,' + Buffer.from(doc).toString('base64'));
      body = body.replace(/<link[^>]+fonts[^>]*>/g, '').replaceAll('https://files-blkstocks.com/brand/bos-logo-light.png', 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="35"><text x="0" y="28" fill="white" font-size="28">blkStocks</text></svg>').toString('base64'));
      if (url.searchParams.has('theme')) body = body.replace('</head>', '<style>:root{color-scheme:' + (url.searchParams.get('theme') === 'dark' ? 'dark' : 'light') + '!important}</style></head>');
    }
    res.writeHead(response.status, { ...Object.fromEntries(response.headers), 'Cache-Control': 'no-store' }); res.end(body);
  } catch { res.writeHead(500); res.end('Fixture server error'); }
}).listen(18918, '127.0.0.1', () => console.log('Synthetic tracking build: http://127.0.0.1:18918/preview'));
