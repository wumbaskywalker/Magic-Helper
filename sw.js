// Magic Helper — Service Worker
// Version bump here forces cache refresh on redeploy
const CACHE = 'magic-helper-v1';

const APP_SHELL = [
  '/',
  '/index.html',
  '/data/logo.png',
  '/data/coin-plat.png',
  '/data/coin-krone.png',
  '/data/image_a8185c.png',
  '/data/image_a81806.png',
  '/data/image.png'
];

// Install: pre-cache the app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate: delete old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy:
//   - External APIs (Scryfall, exchange rates, CDN scripts) → network first, no caching
//   - Everything else → cache first, fall back to network and cache result
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Skip non-GET and cross-origin API/CDN requests
  if (event.request.method !== 'GET') return;
  if (
    url.includes('api.scryfall.com') ||
    url.includes('open.er-api.com') ||
    url.includes('cdnjs.cloudflare.com') ||
    url.includes('cdn.jsdelivr.net')
  ) {
    // Network only — live data should always be fresh
    event.respondWith(fetch(event.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Cache first for app shell and images
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful responses
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
