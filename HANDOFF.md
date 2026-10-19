# Tracking location history activation

2026-10-19. Justin approved key configuration, Cloudflare verification and go-live.

The existing tracking Worker has the verified TAI_API_KEY encrypted secret. The original login secrets are retained and unused. No key or real shipment response is in source or commits.

The release preserves status, details, POD/BOL and manual tracking, adding the approved desktop route view and mobile Journey/Details/Documents tabs. Location history uses separate Durable Object storage; FREIGHT_DB is read-only. No Make or BOS webhook/document flow changes, D1 migration/backfill or customer send.

## Staged verification

The first staged deployment was 5e2a46c / fc854623, followed by the safe pause 8e4496e / bc60bdb2, both verified at 100% traffic. The customer map has remained hidden. The existing credential succeeded directly, but the first Worker read returned unavailable.

Root cause reproduced in workerd: calling native fetch as an object method throws Illegal invocation; redirect:error is also unsupported. The fixes use an arrow wrapper and redirect:manual with non-2xx rejection. Real-runtime tests cover successful history, persisted final reuse and no redirect forwarding. Coarse failure-stage/status logs contain no keys, provider bodies or locations.

Staged configuration: TRACKING_LOCATIONS_ENABLED=true, TAI_REFRESH_ENABLED=true, TRACKING_LOCATIONS_UI_ENABLED=false. Respect the persisted failed-request cooldown; verify one hosted read after it expires, then enable UI only on success. The prior unavailable result does not establish a TAI firewall rejection.

Gates: npm test (49 existing + 18 location/API/rendering), npm run test:runtime (2 real workerd checks), negative controls, bundle and served browser review. Final activation still requires the newest deployment/traffic read, hosted history, preserved status/documents and desktop/phone UI verification.

To stop provider traffic, set TAI_REFRESH_ENABLED=false. TRACKING_LOCATIONS_UI_ENABLED=false hides the map; TRACKING_LOCATIONS_ENABLED=false disables both map and API. Keep the Durable Object migration on rollback.

The temporary remote probe was automatically rejected for introducing another credential-receiving service and was never executed. It was replaced with the approved existing-Worker secret path.

See LOCATION_HISTORY.md and the archived pre-activation handoff.
