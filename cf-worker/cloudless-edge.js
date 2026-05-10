/**
 * Cloudless Edge Worker
 * Deploys to Cloudflare Workers — runs at ~300 PoPs worldwide.
 *
 * Routes:
 *   cloudless.online/*          → edge caches static assets; passes SSR to Pi
 *   manage.cloudless.online/*   → edge caches static assets; passes auth/API/WS to Pi
 *
 * To deploy:
 *   1. Create CF token with: Workers Scripts:Edit + Zone:Workers Routes:Edit
 *   2. Run: bash cf-worker/deploy.sh
 *
 * Static asset TTLs (managed here, not on origin):
 *   /_next/static/**            1 year  (Next.js content-addressed)
 *   *.js / *.css / *.woff2     1 year  (cloudless-manager build assets)
 *   *.svg / *.png / *.ico      30 days (icons)
 *   manifest.json              24 hours
 *   HTML / API / WS            0 (never cached, always origin)
 */

const STATIC_YEAR  = 31536000;   // 1 year
const STATIC_MONTH = 2592000;    // 30 days
const STATIC_DAY   = 86400;      // 24 hours

/** Returns cache TTL in seconds, or 0 to bypass cache */
function cacheTTL(url) {
  const path = url.pathname;

  // Next.js content-addressed bundles — safe to cache forever
  if (path.startsWith('/_next/static/')) return STATIC_YEAR;

  // cloudless-manager hashed assets
  if (/\.(js|css|woff2?|ttf|eot|otf)$/i.test(path)) return STATIC_YEAR;

  // Images and icons
  if (/\.(png|jpg|jpeg|gif|svg|ico|webp)$/i.test(path)) return STATIC_MONTH;

  // PWA manifest
  if (path === '/manifest.json' || path === '/manifest.webmanifest') return STATIC_DAY;

  // sw.js — always bypass (browser handles service worker updates)
  if (path === '/sw.js') return 0;

  // WebSocket upgrade — cannot cache
  if (path.startsWith('/ws/')) return 0;

  // API routes — never cache
  if (path.startsWith('/api/')) return 0;

  // Auth callbacks — never cache
  if (path.startsWith('/oauth2/') || path.startsWith('/auth/')) return 0;

  // HTML pages — 0 for auth-gated SSR, let origin decide
  return 0;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const ttl = cacheTTL(url);

    // WebSocket upgrade — pass through immediately, Workers cannot proxy WS natively
    // (cloudless-manager WebSocket log streaming goes direct to origin)
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() === 'websocket') {
      return fetch(request);
    }

    // Non-cacheable path — fetch from origin directly
    if (ttl === 0) {
      return fetch(request);
    }

    // Cacheable static asset — check CF Cache API first
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), {
      method: 'GET',
      headers: { 'Accept-Encoding': request.headers.get('Accept-Encoding') || '' }
    });

    let response = await cache.match(cacheKey);

    if (response) {
      // Cache hit — serve from nearest PoP, add debug header
      const headers = new Headers(response.headers);
      headers.set('X-Cache', 'HIT');
      return new Response(response.body, { status: response.status, headers });
    }

    // Cache miss — fetch from origin (Pi via Cloudflare Tunnel)
    const originResponse = await fetch(request);

    // Only cache successful responses
    if (originResponse.ok || originResponse.status === 304) {
      const headers = new Headers(originResponse.headers);
      headers.set('Cache-Control', `public, max-age=${ttl}, immutable`);
      headers.set('X-Cache', 'MISS');
      headers.set('Vary', 'Accept-Encoding');

      const responseToCache = new Response(originResponse.clone().body, {
        status: originResponse.status,
        headers
      });

      // Store in cache asynchronously — don't block the response
      ctx.waitUntil(cache.put(cacheKey, responseToCache));

      // Return to user with cache headers
      headers.set('X-Cache', 'MISS');
      return new Response(originResponse.body, { status: originResponse.status, headers });
    }

    return originResponse;
  }
};
