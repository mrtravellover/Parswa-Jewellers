// Minimal service worker — required by Chrome for the "Install App" prompt.
// Rates are always live, so this intentionally does NOT cache the page;
// it just passes every request straight through to the network.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
