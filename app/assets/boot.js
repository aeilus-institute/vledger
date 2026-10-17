import { start } from './vledger-ui.js';

start();

// Offline use (installable app). The service worker caches only the app's own files.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* works without it */ });
}
