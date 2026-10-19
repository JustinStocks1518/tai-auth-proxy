# Tracking location history activation

2026-10-19. Justin explicitly approved key configuration, Cloudflare verification and go-live.

The approved candidate preserves status, shipment details and documents, with route-first desktop and Journey/Details/Documents phone tabs. Bounded location storage remains separate from read-only FREIGHT_DB. No Make or BOS webhook/document flow is changed.

An existing Camel-issued Authentication Key was found in the original correspondence. One authorized local-machine read returned HTTP 200, matching shipment identity, Delivered status and 100 location reports. No credential or shipment response is committed. The tracking Worker initially had only the retired login secret names.

The approved staged release was deployed at 5e2a46c / fc854623 (100% traffic). The existing Worker now has TAI_API_KEY configured. The controlled hosted read returned state unavailable with no history, so TAI_REFRESH_ENABLED is paused at false and TRACKING_LOCATIONS_UI_ENABLED remains false. TRACKING_LOCATIONS_ENABLED remains true for saved-data reads. Existing customer pages stay on their familiar layout during this check. New SQLite Durable Object provisioning is included; no D1 migration/backfill is needed.

The temporary remote probe was rejected by automatic approval review because it introduced an additional service receiving the credential. That path was abandoned without execution. Use only the existing tracking Worker and its encrypted TAI_API_KEY secret.

Before reporting live: verify secret-name inventory, newest deployment and traffic, the real location API response, unchanged status/documents, and the served desktop/phone map after enabling the UI flag.

To stop provider traffic, set TAI_REFRESH_ENABLED=false. To hide the map while preserving saved API history, set TRACKING_LOCATIONS_UI_ENABLED=false. TRACKING_LOCATIONS_ENABLED=false disables the location API and map. Keep the Durable Object migration during rollback.

See LOCATION_HISTORY.md for limits and verification details. Prior candidate handoff is archived in docs/handoff-archive.

## Cloudflare verification blocker

The same key and endpoint succeeded from the local machine, but failed through the existing Cloudflare Worker on October 19. The current public response deliberately hides provider details; it does not establish a specific upstream HTTP status. No UI activation was performed. Verify upstream rejection details before choosing a transport change. Do not restore the retired proxy or reset durable cooldowns/budgets to force retries.
