// Value Wallet service worker: caches the app shell for offline use. Never sees wallet data
// (the wallet lives in IndexedDB and is never fetched).
const CACHE = 'vledger-app-12';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'icon.svg',
  'assets/boot.js', 'assets/vledger-ui.js', 'assets/vledger-store.js', 'assets/vledger-crypto.js', 'assets/vledger-value.js', 'assets/vledger-qr.js', 'assets/vledger-providers.js', 'assets/vledger-bridge.js',
  'assets/vledger.css', 'assets/locales/en.json', 'assets/locales/ru.json',
];

// The site sends scripts with a long HTTP cache lifetime, so the worker always asks the server: 'reload' on install,
// 'no-cache' (revalidate, cheap with ETag) on every request. Otherwise a new version would cache the old files.
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
// Network first, cache as fallback, so updates arrive when online.
self.addEventListener('fetch', (e) => {
  // Only the app's own files: API calls (relay, provider, arbiter) go straight to the network, untouched and uncached.
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  const fresh = e.request.mode === 'navigate' ? fetch(e.request) : fetch(new Request(e.request, { cache: 'no-cache' }));
  e.respondWith(fresh.then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
