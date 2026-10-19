# Tracking location history activation

2026-10-19. Justin explicitly approved key configuration, Cloudflare verification and go-live.

The approved candidate preserves status, shipment details and documents, with route-first desktop and Journey/Details/Documents phone tabs. Bounded location storage remains separate from read-only FREIGHT_DB. No Make or BOS webhook/document flow is changed.

An existing Camel-issued Authentication Key was found in the original correspondence. One authorized local-machine read returned HTTP 200, matching shipment identity, Delivered status and 100 location reports. No credential or shipment response is committed. The tracking Worker initially had only the retired login secret names.

Activation is staged: TRACKING_LOCATIONS_ENABLED and TAI_REFRESH_ENABLED are true; TRACKING_LOCATIONS_UI_ENABLED is false until the Cloudflare-side read passes. Existing customer pages stay on their familiar layout during this check. New SQLite Durable Object provisioning is included; no D1 migration/backfill is needed.

The temporary remote probe was rejected by automatic approval review because it introduced an additional service receiving the credential. That path was abandoned without execution. Use only the existing tracking Worker and its encrypted TAI_API_KEY secret.

Before reporting live: verify secret-name inventory, newest deployment and traffic, the real location API response, unchanged status/documents, and the served desktop/phone map after enabling the UI flag.

To stop provider traffic, set TAI_REFRESH_ENABLED=false. To hide the map while preserving saved API history, set TRACKING_LOCATIONS_UI_ENABLED=false. TRACKING_LOCATIONS_ENABLED=false disables the location API and map. Keep the Durable Object migration during rollback.

See LOCATION_HISTORY.md for limits and verification details. Prior candidate handoff is archived in docs/handoff-archive.
