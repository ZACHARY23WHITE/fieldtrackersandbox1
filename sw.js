const CACHE_NAME = 'groundscrew-v2';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/fieldtrackersandbox1/',
  '/fieldtrackersandbox1/index.html',
  '/fieldtrackersandbox1/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

function isApiOrExternal(url) {
  const h = url.hostname;
  return (
    h.includes('firebase') ||
    h.includes('firestore') ||
    h.includes('googleapis') ||
    h.includes('gstatic') ||
    h.includes('raw.githubusercontent') ||
    h.includes('cloudfunctions.net') ||
    h.endsWith('.run.app')
  );
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Callable functions use POST — never run through cache logic (fixes CORS + broken fallbacks).
  if (event.request.method !== 'GET') {
    event.respondWith(fetch(event.request));
    return;
  }

  if (isApiOrExternal(url)) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => {
      return caches.match('/index.html')
        .then((c) => c || caches.match('/fieldtrackersandbox1/index.html'))
        .then((c) => c || new Response('Offline', { status: 503, statusText: 'Offline' }));
    })
  );
});
