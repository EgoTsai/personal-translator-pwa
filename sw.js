const CACHE_NAME = 'personal-translator-v3.4.3';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=3.4.3',
  './app.js?v=3.4.3',
  './audio.js?v=3.4.3',
  './pcm-worklet.js?v=3.4.3',
  './gemini.js?v=3.4.3',
  './live.js?v=3.4.3',
  './drive.js?v=3.4.3',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Strictly skip non-GET, cross-origin requests, and non-HTTPS (except local dev loopback)
  const isSafeProtocol =
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'));
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !isSafeProtocol) {
    return;
  }

  const isNav = event.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
  const fetchReq = isNav ? new Request(event.request, { cache: 'no-cache' }) : event.request;

  event.respondWith(
    fetch(fetchReq)
      .then((resp) => {
        if (
          resp &&
          resp.status === 200 &&
          resp.type === 'basic' &&
          url.origin === self.location.origin
        ) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});
