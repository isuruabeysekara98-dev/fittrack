// FitTrack Service Worker
const CACHE = 'fittrack-v6';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/utils.js',
  '/manifest.json',
  '/icon.svg',
];

// Cache app shell on install
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

// Remove old caches on activate
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Never intercept Google API or auth calls
  if (url.includes('googleapis.com') || url.includes('accounts.google.com') || url.includes('gsi/client')) {
    return;
  }

  // Network-first for app code so changes are picked up immediately.
  // Falls back to cache when offline.
  const isAppCode = /\/(app\.js|utils\.js|style\.css|index\.html)(\?|$)/.test(url);

  if (isAppCode) {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          if (resp.status === 200) caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
          return resp;
        })
        .catch(() => caches.match(e.request).then(c => c || caches.match('/index.html')))
    );
    return;
  }

  // Cache-first for everything else (icons, manifest, fonts)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (e.request.method === 'GET' && resp.status === 200)
          caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
        return resp;
      });
    }).catch(() => caches.match('/index.html'))
  );
});
