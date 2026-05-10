// ── Cloudless Manager Service Worker ─────────────────────────────────────────
const CACHE_NAME = 'cloudless-v1';

// App shell resources to pre-cache on install
const PRECACHE = [
  '/',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/icon-maskable.svg',
  'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js'
];

// ── Install: pre-cache the app shell ─────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE).catch(err => {
        // CDN might be unreachable on first offline install — only fail hard on local assets
        console.warn('[SW] Precache partial failure:', err);
        return cache.addAll(['/', '/manifest.json', '/icons/icon.svg']);
      });
    })
  );
  // Activate immediately (don't wait for old SW clients to close)
  self.skipWaiting();
});

// ── Activate: delete stale caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: routing strategy ───────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. Skip non-GET requests entirely (POST/PUT/DELETE always go to network)
  if (event.request.method !== 'GET') return;

  // 2. Skip API and WebSocket endpoints — always live data, never cache
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;

  // 3. Skip chrome-extension and non-http(s) requests
  if (!url.protocol.startsWith('http')) return;

  // 4. App shell (same origin) — cache-first, then network + update cache
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(event.request).then(cached => {
          const networkFetch = fetch(event.request).then(response => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          }).catch(() => null);

          // Return cached immediately if available; background-update cache
          return cached || networkFetch || caches.match('/');
        })
      )
    );
    return;
  }

  // 5. CDN resources (chart.js etc.) — stale-while-revalidate
  if (url.hostname.includes('jsdelivr.net') || url.hostname.includes('cdn.')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(event.request).then(cached => {
          const networkFetch = fetch(event.request).then(response => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          }).catch(() => cached); // offline: serve stale

          return cached || networkFetch;
        })
      )
    );
  }
});

// ── Push notifications (future use) ──────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  self.registration.showNotification(data.title || 'Cloudless Alert', {
    body:    data.body   || '',
    icon:    '/icons/icon.svg',
    badge:   '/icons/icon-maskable.svg',
    tag:     data.tag    || 'cloudless',
    data:    data.url    || '/'
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data || '/')
  );
});
