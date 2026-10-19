# Tracking location history activation

2026-10-19. Justin approved key configuration, Cloudflare verification and go-live.

The existing tracking Worker has the verified encrypted TAI_API_KEY. Retired login secrets are unchanged and unused. No key or real shipment response is in source or commits.

The controlled Cloudflare retrieval returned and stored 100 reports, confirmed final delivery, and reused the stored snapshot. All three feature flags are now true. The reviewed map is live and verified in the served desktop and phone layouts.

Status, details, POD/BOL and manual tracking remain on their existing data paths. Desktop is route-first; phones use Journey/Details/Documents tabs under the familiar status bar. Location history uses separate Durable Object storage; FREIGHT_DB stays read-only. No Make/BOS webhook or document-flow change, D1 migration/backfill or customer send.

## Runtime fixes and checks

The first staged attempt failed before TAI I/O. Real workerd tests exposed native fetch receiver binding and unsupported redirect:error. The fixes wrap global fetch and use redirect:manual with non-2xx rejection. Coarse diagnostics contain stage/status only, never credentials or location data. The normal failure cooldown was preserved before the successful retry.

Gates: 49 existing checks, 18 location/API/rendering checks, 2 native workerd tests; all five negative controls killed; reserved-slot bundle passed. The actual Wrangler bundle was also browser-tested with synthetic data after correcting inline-function serialization.

To stop provider traffic, set TAI_REFRESH_ENABLED=false. TRACKING_LOCATIONS_UI_ENABLED=false hides the map; TRACKING_LOCATIONS_ENABLED=false disables both map and API. Keep the Durable Object migration on rollback.

Automatic review rejected a separate temporary credential-receiving probe; it was never executed. Verification used only the existing approved Worker.

See LOCATION_HISTORY.md and the archived pre-activation handoff.

## Production receipt

- Runtime commit fbeefb5ba86e64efb6fadbabe0e1b5a22a28cdef; clean HEAD equaled freshly fetched origin/main before npm run deploy. Push and deployment were separate calls.
- Newest deployments list entry 2026-10-19T20:51:42.540Z: af078a0e-0fc8-430b-b3e1-ee96d643108c at 100% traffic.
- Controlled hosted read: HTTP 200, final state, 100 reports with source timestamps and coordinates, no truncation. Saved GET matched; later browser opens reused the final snapshot.
- Live title, status timeline, all five original detail rows and both document links matched the pre-release page exactly. POD loaded in the original viewer. History expansion/selection and keyboard tabs worked. Desktop and 390px/320px phones had no horizontal overflow or new console errors.
- keep_names=false prevents Wrangler injecting an external helper into the serialized inline client; layout cache version v2 evicts the old broken HTML. Browser-cached pages may need a refresh. Keep the client self-contained and browser-test the actual Wrangler bundle, not only raw source fixtures.
- Local fixture checks covered light/dark and active/stale/empty/failed states. Live checks used the existing dark system appearance. OS-level reduced motion and a real document download were not separately exercised.
- Review Page updated: https://chatgpt.com/space/page_0d85e62017c8819185db1c09159099f7. Documentation-only receipt commits do not redeploy.
