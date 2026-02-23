/**
 * TAI Shipment Tracking Auth Proxy
 * 
 * Reverse proxy pattern: all requests to track.blkstocks.com are proxied
 * through to camellogisticsgroup.taicloud.net with the .ASPXAUTH cookie
 * injected server-side. Credentials never reach the browser.
 * 
 * Entry point: track.blkstocks.com/{shipmentId}
 * Proxied:     track.blkstocks.com/* → camellogisticsgroup.taicloud.net/*
 */

// ─── Session cache TTL (4 hours) ───
const AUTH_CACHE_TTL = 14400;

// ─── Paths that don't need auth (login page itself, static assets if any) ───
const NO_AUTH_PATHS = ['/Account/LoginAjax'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── Handle CORS preflight ──
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }

    // ── Root path → simple landing / health check ──
    if (path === '/' || path === '') {
      return new Response('blkStocks Shipment Tracking', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // ── Entry point: /127209205 → redirect to proxied SPA with hash route ──
    if (/^\/(\d+)$/.test(path)) {
      const shipmentId = path.slice(1);
      return Response.redirect(
        `${url.origin}/FrontOffice#/trackshipment/${shipmentId}`,
        302
      );
    }

    // ── Reverse proxy everything else to TAI ──
    return await proxyToTAI(request, env, ctx, url);
  },
};


// ═══════════════════════════════════════════════════════
//  REVERSE PROXY
// ═══════════════════════════════════════════════════════

async function proxyToTAI(request, env, ctx, url) {
  const path = url.pathname;
  const taiTarget = `${env.TAI_BASE_URL}${path}${url.search}`;

  // ── Get auth cookie (cached or fresh) ──
  const authCookie = await getAuthCookie(env);
  if (!authCookie) {
    return new Response(errorPage('Authentication with TAI failed. Please try again or contact Justin.'), {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // ── Build proxied request headers ──
  const proxyHeaders = new Headers();

  // Forward safe headers from the original request
  const forwardHeaders = [
    'Accept', 'Accept-Language', 'Accept-Encoding',
    'Content-Type', 'Content-Length',
    'X-Requested-With', 'Cache-Control', 'Pragma',
  ];
  for (const h of forwardHeaders) {
    if (request.headers.has(h)) {
      proxyHeaders.set(h, request.headers.get(h));
    }
  }

  // Set TAI-specific headers
  proxyHeaders.set('Host', env.TAI_DOMAIN);
  proxyHeaders.set('Origin', env.TAI_BASE_URL);
  proxyHeaders.set('Referer', `${env.TAI_BASE_URL}/`);
  proxyHeaders.set('Cookie', `.ASPXAUTH=${authCookie}`);

  // ── Make the proxied request ──
  let taiResponse;
  try {
    taiResponse = await fetch(taiTarget, {
      method: request.method,
      headers: proxyHeaders,
      body: hasBody(request.method) ? request.body : undefined,
      redirect: 'manual', // Handle redirects ourselves so we can rewrite URLs
    });
  } catch (err) {
    return new Response(errorPage(`Failed to reach TAI: ${err.message}`), {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // ── If TAI returns a redirect, rewrite the Location header ──
  if ([301, 302, 303, 307, 308].includes(taiResponse.status)) {
    const location = taiResponse.headers.get('Location');
    if (location) {
      const rewritten = rewriteUrl(location, env.TAI_DOMAIN, url.host);
      return Response.redirect(rewritten, taiResponse.status);
    }
  }

  // ── If TAI returns 401/403, auth cookie may be expired → force re-login ──
  if (taiResponse.status === 401 || taiResponse.status === 403) {
    await env.TAI_SESSION.delete('aspxauth');
    // Retry once with fresh auth
    const freshCookie = await getAuthCookie(env);
    if (freshCookie) {
      proxyHeaders.set('Cookie', `.ASPXAUTH=${freshCookie}`);
      taiResponse = await fetch(taiTarget, {
        method: request.method,
        headers: proxyHeaders,
        body: hasBody(request.method) ? request.body : undefined,
        redirect: 'manual',
      });
    }
  }

  // ── Build the response ──
  const responseHeaders = new Headers();

  // Copy safe response headers (skip ones that cause issues through a proxy)
  const skipHeaders = new Set([
    'content-security-policy',
    'x-frame-options',
    'strict-transport-security',
    'transfer-encoding',        // Workers handle this
    'content-encoding',         // Workers handle decompression
    'set-cookie',               // Don't leak TAI cookies to browser
  ]);

  for (const [key, value] of taiResponse.headers.entries()) {
    if (!skipHeaders.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  }

  // Add CORS headers (so Softr embeds work if needed)
  responseHeaders.set('Access-Control-Allow-Origin', '*');
  responseHeaders.set('X-Proxied-By', 'blkstocks-tai-proxy');

  // ── Rewrite URLs in text responses (HTML, JS, CSS) ──
  const contentType = taiResponse.headers.get('Content-Type') || '';
  const isText = contentType.includes('text/html')
    || contentType.includes('javascript')
    || contentType.includes('text/css')
    || contentType.includes('application/json');

  if (isText) {
    let body = await taiResponse.text();
    body = rewriteBody(body, env.TAI_DOMAIN, url.host);

    return new Response(body, {
      status: taiResponse.status,
      headers: responseHeaders,
    });
  }

  // Binary content (images, fonts, etc.) — pass through as-is
  return new Response(taiResponse.body, {
    status: taiResponse.status,
    headers: responseHeaders,
  });
}


// ═══════════════════════════════════════════════════════
//  AUTH / SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════

async function getAuthCookie(env) {
  // ── Check KV cache ──
  const cached = await env.TAI_SESSION.get('aspxauth');
  if (cached) {
    return cached;
  }

  // ── Login to TAI ──
  let loginResponse;
  try {
    loginResponse = await fetch(`${env.TAI_BASE_URL}/Account/LoginAjax`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': env.TAI_BASE_URL,
        'Referer': `${env.TAI_BASE_URL}/`,
      },
      body: JSON.stringify({
        Username: env.TAI_USERNAME,
        Password: env.TAI_PASSWORD,
      }),
    });
  } catch (err) {
    console.error('TAI login request failed:', err.message);
    return null;
  }

  // ── Extract .ASPXAUTH from Set-Cookie ──
  // Workers may return multiple Set-Cookie values joined by comma or as separate entries
  const authValue = extractAspxAuth(loginResponse);

  if (!authValue) {
    console.error('No .ASPXAUTH cookie in TAI login response. Status:', loginResponse.status);
    // Log response body for debugging (will show in Workers logs)
    try {
      const body = await loginResponse.text();
      console.error('Login response body:', body.substring(0, 500));
    } catch (_) {}
    return null;
  }

  // ── Cache in KV ──
  await env.TAI_SESSION.put('aspxauth', authValue, {
    expirationTtl: AUTH_CACHE_TTL,
  });

  console.log('TAI auth cookie cached successfully');
  return authValue;
}

/**
 * Extract .ASPXAUTH value from the login response headers.
 * Handles both single and multiple Set-Cookie headers.
 */
function extractAspxAuth(response) {
  // Try getSetCookie() first (available in modern Workers runtime)
  if (typeof response.headers.getSetCookie === 'function') {
    const cookies = response.headers.getSetCookie();
    for (const cookie of cookies) {
      const match = cookie.match(/\.ASPXAUTH=([^;]+)/);
      if (match) return match[1];
    }
  }

  // Fallback: parse from get('Set-Cookie') which joins with ', '
  const raw = response.headers.get('Set-Cookie');
  if (raw) {
    const match = raw.match(/\.ASPXAUTH=([^;]+)/);
    if (match) return match[1];
  }

  return null;
}


// ═══════════════════════════════════════════════════════
//  URL REWRITING
// ═══════════════════════════════════════════════════════

/**
 * Rewrite all references to the TAI domain so they route through our proxy.
 * Handles both https://domain and //domain patterns.
 */
function rewriteBody(body, taiDomain, proxyHost) {
  // https://camellogisticsgroup.taicloud.net → https://track.blkstocks.com
  body = body.replaceAll(`https://${taiDomain}`, `https://${proxyHost}`);
  // //camellogisticsgroup.taicloud.net → //track.blkstocks.com
  body = body.replaceAll(`//${taiDomain}`, `//${proxyHost}`);

  return body;
}

/**
 * Rewrite a single URL (used for Location headers, etc.)
 */
function rewriteUrl(urlStr, taiDomain, proxyHost) {
  if (urlStr.startsWith('/')) {
    // Relative URL — prefix with our origin
    return `https://${proxyHost}${urlStr}`;
  }
  return urlStr
    .replace(`https://${taiDomain}`, `https://${proxyHost}`)
    .replace(`//${taiDomain}`, `//${proxyHost}`);
}


// ═══════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════

function hasBody(method) {
  return method !== 'GET' && method !== 'HEAD';
}

function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With, Accept',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function errorPage(message) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Tracking Error — blkStocks</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           display: flex; justify-content: center; align-items: center;
           min-height: 100vh; margin: 0; background: #f5f5f5; color: #333; }
    .card { background: white; border-radius: 8px; padding: 40px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 500px; text-align: center; }
    h1 { font-size: 20px; margin-bottom: 12px; }
    p  { color: #666; line-height: 1.5; }
    a  { color: #2563eb; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Unable to Load Tracking</h1>
    <p>${message}</p>
    <p style="margin-top: 20px;"><a href="javascript:location.reload()">Try Again</a></p>
  </div>
</body>
</html>`;
}
