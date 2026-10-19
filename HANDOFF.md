# Tracking location history activation

2026-10-19. Justin approved key configuration, Cloudflare verification and go-live.

The existing tracking Worker has the verified encrypted TAI_API_KEY. Retired login secrets are unchanged and unused. No key or real shipment response is in source or commits.

The controlled Cloudflare retrieval returned and stored 100 reports, confirmed final delivery, and reused the stored snapshot. All three feature flags are now true. This release enables the reviewed map; the final served desktop/phone receipt will follow verification.

Status, details, POD/BOL and manual tracking remain on their existing data paths. Desktop is route-first; phones use Journey/Details/Documents tabs under the familiar status bar. Location history uses separate Durable Object storage; FREIGHT_DB stays read-only. No Make/BOS webhook or document-flow change, D1 migration/backfill or customer send.

## Runtime fixes and checks

The first staged attempt failed before TAI I/O. Real workerd tests exposed native fetch receiver binding and unsupported redirect:error. The fixes wrap global fetch and use redirect:manual with non-2xx rejection. Coarse diagnostics contain stage/status only, never credentials or location data. The normal failure cooldown was preserved before the successful retry.

Gates: 49 existing checks, 18 location/API/rendering checks, 2 native workerd tests; all five negative controls killed; reserved-slot bundle passed. Final production/browser receipt follows.

To stop provider traffic, set TAI_REFRESH_ENABLED=false. TRACKING_LOCATIONS_UI_ENABLED=false hides the map; TRACKING_LOCATIONS_ENABLED=false disables both map and API. Keep the Durable Object migration on rollback.

Automatic review rejected a separate temporary credential-receiving probe; it was never executed. Verification used only the existing approved Worker.

See LOCATION_HISTORY.md and the archived pre-activation handoff.
