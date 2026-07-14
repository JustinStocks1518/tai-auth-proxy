# blkStocks Shipment Tracking — Cloudflare Worker

## Overview
Branded, mobile-first shipment status page for blkStocks customers and field
crews. Users open `shipment.trackblkstocks.com/{shipmentId}` from an SMS or
email link and see status, carrier, last location, and ETA — no login.

**Rebuilt 2026-07-14.** This worker was previously an authenticated reverse
proxy to TAI's FrontOffice (camellogisticsgroup.taicloud.net). That design let
SMS link-scanners, email gateways, and crawlers push ~500k requests to TAI in
3 days (see `C:\Projects\TAI-AUDIT.md`), getting the ops API user throttled.
**The worker now never contacts TAI.** All shipment data comes from bos-app's
freight D1 database, which is fed by TAI's webhook push into
`app.blkstocks.com/api/freight/webhook`.

## Architecture
- **Domain:** shipment.trackblkstocks.com (custom domain, bound in dashboard).
  `workers_dev = false` — the workers.dev alias deliberately does not resolve.
- **Data:** D1 `freight-data` (bos-app's database), binding `FREIGHT_DB`,
  **read-only by convention** — single `SELECT ... WHERE tai_shipment_id = ?`.
  Never write to it from this worker; bos-app owns schema + migrations.
- **Auth model:** possession of the link (same as before). Only limited fields
  render: status, ETA, carrier, origin/destination, last location, PO
  reference, project name. **No cost/pricing fields are ever selected.**
- **Caching:** rendered status pages edge-cached 5 min (Cache API) +
  `Cache-Control: public, max-age=300`. Landing/shim/robots cached longer.

## Routes
| Path | Behavior |
|---|---|
| `/{shipmentId}` | Status page. Accepts TAI numeric ids (6–12 digits) and manual `MAN-…` ids. Unknown id → branded not-found page (404) with a contact line. |
| `/FrontOffice` | Legacy hash-link shim. Historical links are `/FrontOffice#/trackshipment/{id}`; the fragment never reaches the server, so this page's inline JS reads `location.hash` and redirects to `/{id}`. Keeps every link ever written into Monday/SMS/email resolving. |
| `/robots.txt` | `User-agent: * / Disallow: /` (served locally). |
| `/` | Branded landing page. |
| `/favicon.ico` | 204. |
| anything else | Branded 404. **Nothing is ever forwarded anywhere.** |

## Status timeline mapping (`statusStage` in src/index.js)
Booked (Quoted/Booked/Committed/Ready/Scheduled/Dispatched/Pending) →
Picked Up (or `actual_pickup` set) → In Transit → Out for Delivery →
Delivered (or `actual_delivery` set). `Canceled` renders a badge, no timeline.
Real pickup/delivery timestamps only push the stage forward — a stale status
label can't regress actual progress.

## Historical URL shapes that must keep resolving
- `https://shipment.trackblkstocks.com/FrontOffice#/trackshipment/{id}` —
  bos-app Monday link column + SMS + freight page + Field Schedule + m3 chat.
- `https://track.blkstocks.com/{id}` — early Make.com links (if that domain is
  bound, the worker serves it identically — routing is host-agnostic).
- `https://tai-auth-proxy.justin-8f0.workers.dev/{id}` — written by the Make
  "TAI Tracking Webhook" scenario module 21. **These break by design**
  (`workers_dev = false`); backfill those Monday link columns to the custom
  domain if anyone reports a dead link.

## Brand
DM Sans (Google Fonts), Deep Teal `#2D4A54` header, Soft Blue `#96BDCC`
accents, Off-White `#F5F7FA` background, white logo
`https://files-blkstocks.com/brand/bos-logo-light.png` on the teal header.

## Tests
`node test/status-page.test.mjs` — route parsing for every historical URL
shape, stage mapping, render fixtures (status/not-found/robots/404 allowlist),
run against a stubbed `FREIGHT_DB`.

## Deployment
`npx wrangler deploy` (see DEPLOY.md). No secrets, no KV. The old
`TAI_SESSION` KV namespace and TAI login secrets are retired — delete them
and rotate the TAI account password.

## Contacts
- **Shane @ Camel Logistics** — TAI webhook configuration
- **Justin (Dir. of Technology)** — blkStocks internal owner
