# TAI Auth Proxy — Deployment Guide

## Prerequisites

- Wrangler CLI installed (`npm install -g wrangler`)
- Authenticated with Cloudflare (`wrangler login`)
- blkStocks Cloudflare account access
- TAI credentials ready (operations@blkstocks.com)

---

## Step 1: Create the KV Namespace

```bash
# Create the namespace
wrangler kv namespace create TAI_SESSION

# Output will look like:
# ⛅ Creating namespace "tai-auth-proxy-TAI_SESSION"
# ✅ Success! Add the following to your wrangler.toml:
# [[kv_namespaces]]
# binding = "TAI_SESSION"
# id = "abc123def456..."
```

**Copy the `id` value** and paste it into `wrangler.toml` replacing `YOUR_KV_NAMESPACE_ID_HERE`.

---

## Step 2: Set Secrets

```bash
# Run from the project root (where wrangler.toml is)
wrangler secret put TAI_USERNAME
# When prompted, enter: operations@blkstocks.com

wrangler secret put TAI_PASSWORD
# When prompted, enter the password
```

These are encrypted at rest and never visible in logs or dashboards.

---

## Step 3: Deploy

```bash
wrangler deploy
```

The Worker will deploy to `tai-auth-proxy.<your-account>.workers.dev`.

---

## Step 4: Add Custom Domain

1. Go to **Cloudflare Dashboard** → **Workers & Pages** → **tai-auth-proxy**
2. Click **Settings** → **Domains & Routes**
3. Click **Add** → **Custom Domain**
4. Enter: `track.blkstocks.com`
5. Cloudflare will auto-create the DNS record (since blkStocks DNS is already on Cloudflare)

Wait 1–2 minutes for DNS propagation.

---

## Step 5: Test

### Basic health check
```
https://track.blkstocks.com/
→ Should return "blkStocks Shipment Tracking"
```

### Shipment entry point (delivered shipment)
```
https://track.blkstocks.com/127209205
→ Should 302 redirect to /FrontOffice#/trackshipment/127209205
→ Tracking page should load with map, status, carrier info
```

### Shipment entry point (active shipment)
```
https://track.blkstocks.com/127003337
→ Same flow — verify live tracking data appears
```

### Invalid ID
```
https://track.blkstocks.com/abc
→ Falls through to proxy (TAI will 404 — that's fine)
```

### Session caching check
```bash
# View cached cookie in KV
wrangler kv key get --binding=TAI_SESSION "aspxauth"

# Force clear cache to test re-login
wrangler kv key delete --binding=TAI_SESSION "aspxauth"

# Next request will trigger fresh login
```

### View Worker logs (real-time)
```bash
wrangler tail
# Shows console.log/console.error output from the Worker
# Useful for debugging login failures
```

---

## Step 6: Update Make.com Links (Post-Launch)

Once tracking is confirmed working, update Module 6 / Module 17 in your Make.com scenario to write links as:

```json
{
  "link_mm0n51eg": {
    "url": "https://track.blkstocks.com/{{1.shipmentId}}",
    "text": "Track Shipment"
  }
}
```

Existing direct TAI links on older subitems will still work (manual login required).

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| "Authentication with TAI failed" error page | Wrong credentials or TAI endpoint changed | Check `wrangler tail` logs. Verify secrets with `wrangler secret list`. |
| Page loads but shows TAI login screen | Auth cookie expired and KV re-login failed | Clear KV cache: `wrangler kv key delete --binding=TAI_SESSION "aspxauth"` |
| Broken page (missing CSS/JS/images) | TAI assets using a CDN domain we're not rewriting | Check browser DevTools Network tab for failing requests. See "Expanding the Proxy" below. |
| 403 from TAI on login | IP block or rate limit on TAI's end | Contact Shane at Camel Logistics |
| CORS errors in browser console | SPA making cross-origin calls we're not proxying | Assets likely referencing TAI domain directly — see next section |

---

## Expanding the Proxy (When Needed)

The Worker currently rewrites URLs matching `camellogisticsgroup.taicloud.net` in HTML, JS, CSS, and JSON responses. If TAI's SPA loads assets from a **different** domain (e.g., a CDN subdomain or third-party service), those won't be proxied.

**To diagnose:** Open `track.blkstocks.com/127209205` in Chrome → DevTools → Network tab. Look for any requests going directly to `camellogisticsgroup.taicloud.net` or other TAI domains instead of through `track.blkstocks.com`.

**To fix:** Add additional domain rewrites in the `rewriteBody()` function:

```javascript
// Example: if TAI uses a CDN at cdn.taicloud.net
body = body.replaceAll('https://cdn.taicloud.net', `https://${proxyHost}/cdn-proxy`);
```

Then add a route handler in the main fetch to proxy `/cdn-proxy/*` to that CDN.

---

## Architecture Summary

```
User clicks track.blkstocks.com/127209205
        │
        ▼
┌─────────────────────────────┐
│  Worker: extract shipmentId │
│  302 → /FrontOffice#/track  │
│         shipment/127209205  │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  Browser requests           │
│  /FrontOffice from Worker   │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  Worker: check KV for       │
│  cached .ASPXAUTH cookie    │
│  ┌──────────────────────┐   │
│  │ Cached? → Use it     │   │
│  │ Missing? → Login,    │   │
│  │   cache new cookie   │   │
│  └──────────────────────┘   │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  Proxy request to TAI with  │
│  .ASPXAUTH cookie injected  │
│  Rewrite URLs in response   │
│  Return to browser          │
└─────────────────────────────┘
           │
           ▼
   SPA loads, makes API calls
   All routed through Worker
   (browser only sees
    track.blkstocks.com)
```
