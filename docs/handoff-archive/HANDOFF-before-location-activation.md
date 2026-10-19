# Tracking location history handoff

2026-10-19. Candidate branch: `worktree-location-history`. Not landed, deployed or activated.

Justin approved starting the build after selecting route-first desktop and a Journey/Details/Documents tabbed card on phones. The four-stage status bar stays at the top. This authorization did not include production activation.

Implemented separate location-history storage, a bounded GET to TAI initiated by a visible-page POST, per-shipment cooldown, concurrent-request coalescing, shared budget, retry backoff, source-time validation and saved-data fallback. FREIGHT_DB remains read-only. No Make or BOS webhook/document processing was changed.

The UI preserves the existing field conditionals, document viewer, manual tracking link and office contact. The map reuses BOS Field geography, labels major cities, distinguishes approximate bookend city markers from reported positions, and labels the dotted onward line as direction only. Source and check timestamps are separate. Motion is once per page and suppressed for stale/failed/delivered/reduced-motion states.

Validation: 49 original tests plus 17 location/API/rendering tests passed. Reserved-slot Wrangler dry-run passed; bundle about 399 KiB gzip. Browser checks use the real worker and scripts with synthetic data only. Current browser review is captured in LOCATION_HISTORY.md and the review Page.

Activation requires secure `TAI_API_KEY` configuration and confirmation that it authorizes this shipment account at the documented endpoint, one approved real-shipment comparison, and Justin's go-live approval. Secret-name inventory found only retired login secret names; values were neither read nor reused. Keep both committed feature flags false until activation is approved. New Durable Object provisioning is included in the candidate configuration; no D1 migration is needed.

See [LOCATION_HISTORY.md](LOCATION_HISTORY.md) for bounds, fallback/rollback behavior, official references and local preview instructions. Never restore the retired authenticated proxy.
