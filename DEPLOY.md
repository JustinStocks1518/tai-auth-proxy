# Shipment tracking deployment

The existing Worker serves shipment.trackblkstocks.com. Shipment status, details and documents read BOS freight D1. The October 19 location extension uses a separate SQLite Durable Object and an encrypted server-side TAI_API_KEY.

## Release

1. Reserve the machine-wide Wrangler slot for every call, including reads and dry runs.
2. Run npm test, npm run test:runtime, npm run test:mutants, a bundle check and served browser verification appropriate to the change.
3. Commit and push separately from deployment. Freshly fetch origin/main; require a clean checkout whose HEAD matches it.
4. Run npm run deploy. Read the newest Wrangler deployments list entry and verify 100% traffic on the intended version.
5. Verify the custom domain, preserved status/details/POD/BOL, location history, and responsive layout. Docs-only receipts do not deploy.

## Configuration

TRACKING_LOCATIONS_ENABLED=true enables the saved-history API. TAI_REFRESH_ENABLED=true allows bounded provider requests. TRACKING_LOCATIONS_UI_ENABLED=true displays the approved map and mobile tabs. TAI_API_KEY is already configured securely; never place its value in code, docs, links or logs.

For staged verification, keep UI visibility false until one authorized Cloudflare-side retrieval succeeds. Preserve existing cooldowns and budgets. Do not use a new probe service to receive the credential.

## Rollback

Set TAI_REFRESH_ENABLED=false to stop provider traffic while retaining saved history. Set TRACKING_LOCATIONS_UI_ENABLED=false to hide the map. TRACKING_LOCATIONS_ENABLED=false disables the API and map together. Preserve the Durable Object migration and binding. Old browser HTML can remain cached for five minutes, while server flags immediately govern refresh requests.

The retired TAI login secrets and historical session namespace are outside this release. Do not delete or rotate credentials as incidental cleanup. No D1 migration, backfill, Make change, webhook change or customer send is needed.

## References

See LOCATION_HISTORY.md for limits, source timestamps, failure behavior and synthetic previews. HANDOFF.md records the latest serving verification. Legacy /FrontOffice hash links remain supported. The workers.dev alias intentionally stays disabled; use the custom domain.
