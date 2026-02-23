# TAI Auth Proxy — Cloudflare Worker

## Overview
Reverse proxy that gives blkStocks customers seamless shipment tracking without exposing TAI credentials. Users click `track.blkstocks.com/{shipmentId}` and see tracking data — no login required on their end.

## Architecture
- **Domain:** track.blkstocks.com (Cloudflare DNS, custom domain on Worker)
- **Backend:** camellogisticsgroup.taicloud.net (TAI Cloud by Camel Logistics)
- **Auth:** Server-side .ASPXAUTH cookie injection. Browser never sees credentials.
- **Session cache:** Cloudflare KV namespace `TAI_SESSION`, 4-hour TTL
- **Entry point:** `/{shipmentId}` → 302 redirect to `/FrontOffice#/trackshipment/{shipmentId}`
- **Proxy:** All subsequent requests proxied to TAI with auth cookie + URL rewriting

## File Structure
```
tai-auth-proxy/
├── wrangler.toml       # Worker config, KV binding, env vars
├── src/
│   └── index.js        # All Worker logic (single file)
├── DEPLOY.md           # Step-by-step deployment checklist
└── CLAUDE.md           # This file
```

## Key Technical Details
- Auth endpoint: `POST /Account/LoginAjax` (JSON body with Username/Password)
- Auth cookie extracted from `Set-Cookie` header via `.ASPXAUTH=([^;]+)` regex
- URL rewriting in HTML/JS/CSS/JSON responses: TAI domain → proxy domain
- On 401/403: KV cache cleared, fresh login attempted, request retried once
- CORS wide open (`*`) since tracking links are shared externally and may be embedded

## Secrets (set via `wrangler secret put`, never in code)
- `TAI_USERNAME` — operations@blkstocks.com
- `TAI_PASSWORD` — stored in Cloudflare, not documented here

## Environment Variables (in wrangler.toml)
- `TAI_BASE_URL` — https://camellogisticsgroup.taicloud.net
- `TAI_DOMAIN` — camellogisticsgroup.taicloud.net

## Deployment
See DEPLOY.md for full walkthrough. Quick version:
1. `wrangler kv namespace create TAI_SESSION` → paste ID into wrangler.toml
2. `wrangler secret put TAI_USERNAME` / `TAI_PASSWORD`
3. `wrangler deploy`
4. Add custom domain `track.blkstocks.com` in Cloudflare dashboard
5. Test with known shipment IDs: 127209205 (delivered), 127003337 (active)

## Integration Points
- **Make.com:** Scenario modules write tracking links as `https://track.blkstocks.com/{{shipmentId}}` into Monday.com subitems
- **Monday.com:** Tracking links appear on project subitems for customer-facing visibility
- **Softr:** May embed tracking via iframe — CORS headers and no X-Frame-Options support this

## Contacts
- **Shane @ Camel Logistics** — TAI access issues, IP blocks, rate limits
- **Justin (Dir. of Technology)** — blkStocks internal owner

## Known Considerations
- If TAI serves assets from a CDN subdomain, `rewriteBody()` needs additional domain entries
- TAI's SPA uses hash-based routing (`#/trackshipment/...`), so the Worker only needs to handle the initial page load — subsequent navigation is client-side
- The error page directs users to contact Justin if auth fails
