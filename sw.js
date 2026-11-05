'use strict';
/* Service worker: makes the app installable and keeps the app shell available offline.
   The API is never cached - quotes always come live from the server. */
const CACHE = 'infraura-shell-v1';
const SHELL = ['index.html', 'assets/style.css', 'assets/app.js', 'assets/options.js', 'assets/editor.js', 'assets/roof.js', 'assets/quickroof.js', 'assets/projects.js', 'assets/reports.js', 'assets/ai.js', 'assets/i18n.js', 'assets/account.js', 'assets/logo.png', 'assets/favicon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/') || url.pathname.endsWith('view.html')) return;
  // network first so updates show immediately; fall back to cache when offline
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then(r => r || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
