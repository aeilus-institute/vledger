// Value Wallet service worker: caches the app shell for offline use. Never sees wallet data
// (the wallet lives in IndexedDB and is never fetched).
const CACHE = 'vledger-app-5';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'icon.svg',
  'assets/boot.js', 'assets/vledger-ui.js', 'assets/vledger-store.js', 'assets/vledger-crypto.js', 'assets/vledger-value.js', 'assets/vledger-qr.js', 'assets/vledger-providers.js',
  'assets/vledger.css', 'assets/locales/en.json', 'assets/locales/ru.json',
];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
// Network first, cache as fallback, so updates arrive when online.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
