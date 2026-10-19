# Shipment location history candidate

2026-10-19 · isolated branch `worktree-location-history` · not deployed or enabled.

## Selected experience

Visual thesis: the familiar shipment card, with a quiet geographic view of the journey as its primary workspace.
Content: shipment identity and the existing four-stage status bar first; route and current report next; full details and shipping documents remain available.
Interaction: the trail draws once over 850ms, followed by two subtle 1.4-second pulses; report selection highlights its point; phone tabs preserve the selected report and expanded history. Reduced motion, stale reports, failures and delivered shipments suppress entrance motion.

At 760px of available workspace width, the desktop view places the map beside shipment details and documents. Phones open Journey, with Details and Documents tabs below the status bar. POD/BOL continue using the existing viewer, open-new-tab and download controls. Desktop includes document shortcuts. Driver contact remains limited to active shipments; manual carrier links, pickup/delivery timestamps, weight/pieces, customer/vendor/reference and office contact remain intact. Pricing and the broker-entered `pod_signed_by` remain excluded.

The map uses the same US Albers geometry and Census city-center data as BOS Field. Major cities are geographic context, not asserted stops. Only carrier-reported positions form the trail. Pickup/destination markers are explicitly approximate city centers; dotted onward direction is not a road route. Unmapped or text-only reports remain in history. No mileage, progress percentage or map-derived ETA is invented. The existing shipment ETA remains authoritative.

## Request and storage boundary

- Ordinary tracking page GET/HEAD requests and legacy link redirects make no TAI call. Existing five-minute HTML caching remains.
- A visible page loads saved location history, then makes one same-origin POST to request a bounded refresh. There is no recurring polling or background TAI job. A manual check follows the same policy.
- Only a shipment already present in read-only FREIGHT_DB is eligible. Manual and canceled shipments do not refresh. Delivered shipments freeze after a nonempty snapshot whose provider status also confirms delivery; an empty or still-in-transit response remains eligible after cooldown. Failed final attempts can retry after backoff. Existing active cooldowns also apply to final snapshots.
- One SQLite Durable Object instance owns separate history and all refresh reservations. It never writes the shared freight database or invokes the full-shipment webhook/document fallback.
- Concurrent visitors share an in-flight request. Persisted reservations enforce a 15-minute per-shipment cooldown even after an object restart, plus 20 requests per rolling minute and 500 per UTC day across this integration. These limits do not account for other TAI clients sharing credentials or outbound IPs.
- Failure backoff grows from 15 minutes to six hours. 429 Retry-After pauses all requests (bounded at 24 hours); 401/403 pauses all requests for one hour. Server fetch timeout is 10 seconds; browser timeout is 15 seconds. Redirects are rejected. Responses are capped at 2 MiB.
- History is sorted, deduplicated and merged so an older response cannot replace a newer report. Up to the most recent 2,000 valid reports are retained, with explicit truncation wording. Source timestamps require an explicit timezone; invalid/future points cannot silently become current. Untimed top-level locations are displayed without an invented report time.
- The UI distinguishes carrier report time from check time. Details and Journey display the same latest location; this is a browser update only, not a write to the shipment record.

## Configuration and activation

Both committed flags default to `false`: `TRACKING_LOCATIONS_ENABLED` and `TAI_REFRESH_ENABLED`. `TAI_API_KEY` is a server-side secret; never put its value in source, a tracking link, a Page, or chat. The only permitted provider URL is `https://www.taicloud.net/PublicApi/Location/v2/ShipmentLocationHistory/{shipmentId}`.

The read-only Cloudflare secret-name inventory on October 19 found the retired `TAI_USERNAME` and `TAI_PASSWORD` names, but no `TAI_API_KEY`. Their values were not read, printed or reused. No local `.dev.vars` was present in the main tracking repo.

Before activation:

1. Configure the API key securely and confirm with Kyle/Camel that it is authorized for this account and the documented endpoint. Reserve the machine-wide Wrangler slot for every CLI call, including secret commands.
2. Make one explicitly approved real-shipment read and compare its source timestamps/coordinates/history with TAI. Do not send that response to the full-shipment webhook. Verify the existing status, driver, dates and documents remain unchanged.
3. Obtain Justin's go-live approval, review the new Durable Object provisioning, land the clean candidate on freshly fetched main, and deploy from that exact clean commit. Deployment and push must be separate calls. Then enable the approved flags through that reviewed configuration, and verify the newest deployment and served mobile/desktop result.

To stop new TAI traffic, set `TAI_REFRESH_ENABLED=false`; existing stored history remains readable. Set `TRACKING_LOCATIONS_ENABLED=false` to restore the old card. Browser-cached HTML can remain for up to five minutes, while the API flag rejects new refreshes immediately. Do not remove the Durable Object migration when rolling back the UI.

No production D1 migration, production write, webhook change, customer send, secret mutation, deployment, or live TAI request occurred during this build.

## Local verification

`npm ci --ignore-scripts` then `npm test` exercises the real worker, renderer and location receiver against synthetic fixtures. `npm run preview:fixture` serves the real scripts at `http://127.0.0.1:18918/preview`; query `width=390`, `width=320&dark=1&id=900000002`, or `width=1200` for responsive examples. IDs ending 003/004/005/006 exercise stale, empty, failed and manual states. External documents/fonts/brand assets are replaced only in the fixture response. No production services are called.

The source bundle passed esbuild and a reserved-slot `wrangler deploy --dry-run` (about 399 KiB gzip). This is build proof, not production deployment proof. See the test output and browser review receipt for final checks.

Official references: [TAI shipment location history](https://docs.taicloud.net/reference/publicapishipmentlocations_shipmentlocationhistory), [TAI rate limits](https://docs.taicloud.net/docs/public-api-rate-limiting), [Cloudflare Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
