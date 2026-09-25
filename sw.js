// Service worker: caches the app so it runs fully offline after the first visit.
// Bump VERSION whenever any app file changes so phones pick up the update.
const VERSION = 'estate-ledger-v4';
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/db.js',
  './js/zip.js',
  './js/app.js',
  './js/import.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the browser's HTTP cache so a new version never stores stale files.
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      if (req.mode === 'navigate') return caches.match('./index.html');
      return fetch(req);
    })
  );
});
