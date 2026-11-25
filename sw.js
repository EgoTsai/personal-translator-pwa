const CACHE_NAME = 'personal-translator-v2.8';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=2.8',
  './app.js?v=2.8',
  './audio.js?v=2.8',
  './gemini.js?v=2.8',
  './live.js?v=2.8',
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
  // Never intercept Gemini API or non-GET calls
  if (event.request.method !== 'GET' || url.hostname.includes('googleapis.com')) {
    return;
  }

  const isNav = event.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
  const fetchReq = isNav ? new Request(event.request, { cache: 'no-cache' }) : event.request;

  event.respondWith(
    fetch(fetchReq)
      .then((resp) => {
        if (resp && resp.status === 200 && url.origin === self.location.origin) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});
