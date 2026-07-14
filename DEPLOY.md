# blkStocks Shipment Tracking — Deployment Guide

Rebuilt 2026-07-14 as a D1-backed status page (no TAI pass-through, no
secrets, no KV). See CLAUDE.md for architecture and TAI-AUDIT.md (projects
root) for why the old proxy was retired.

## Prerequisites

- Wrangler CLI, authenticated against the blkStocks Cloudflare account
- Nothing else — this worker has **no secrets and no KV**

## Deploy

```bash
npx wrangler deploy
```

`workers_dev = false` in wrangler.toml means the workers.dev URL will NOT
resolve — that's intentional. Traffic arrives only via the custom domain.

## Custom domain (already configured; for reference)

Cloudflare Dashboard → Workers & Pages → tai-auth-proxy → Settings →
Domains & Routes → Custom Domain: `shipment.trackblkstocks.com`.

## Test after deploy

```
https://shipment.trackblkstocks.com/            → branded landing page
https://shipment.trackblkstocks.com/robots.txt  → Disallow: /
https://shipment.trackblkstocks.com/{realShipmentId}
    → branded status page (timeline, carrier, ETA) — pick a recent id from
      D1: npx wrangler d1 execute freight-data --remote --command
      "SELECT tai_shipment_id FROM freight_shipments ORDER BY updated_at DESC LIMIT 3"
https://shipment.trackblkstocks.com/000000      → "Shipment not found" page (404)
https://shipment.trackblkstocks.com/FrontOffice#/trackshipment/{realShipmentId}
    → legacy link shim: redirects to /{realShipmentId}
https://shipment.trackblkstocks.com/anything-else → branded 404
```

Real-time logs: `npx wrangler tail`.

## One-time cleanup after the rebuild is verified

1. Delete the retired secrets from the worker:
   ```bash
   npx wrangler secret delete TAI_USERNAME
   npx wrangler secret delete TAI_PASSWORD
   ```
2. **Rotate the TAI account password** (the old one appeared in a config
   comment; treat it as exposed).
3. Delete the `TAI_SESSION` KV namespace (id `328badd4ba1d4d22af850c80f2c811e1`)
   from the dashboard — nothing references it anymore.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Status page says "Shipment not found" for a real shipment | Shipment not yet in D1 (TAI webhook hasn't delivered) or id typo | Check `freight_shipments` in D1; verify the TAI webhook is pointed at `app.blkstocks.com/api/freight/webhook` |
| Page renders but data is stale | 5-min edge cache | Wait ≤5 min, or purge the URL from the Cloudflare cache |
| D1 errors in `wrangler tail` | Binding/database drift | Confirm the `FREIGHT_DB` binding in wrangler.toml matches bos-app's `freight-data` database id |
