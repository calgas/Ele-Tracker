// Service worker — app-shell caching, with a hard guarantee that batch
// data itself is never served stale.
//
// Strategy, matching Stock Management's sw.js so the two apps behave
// identically:
//  - Anything hitting either Apps Script backend (script.google.com /
//    script.googleusercontent.com), and any non-GET request, is ALWAYS
//    fetched from the network and never cached — batch data must never
//    come from a cache.
//  - Everything else — the app shell (index.html, manifest.json), the
//    brand icons and any static libraries it loads — is cached so a repeat
//    visit is instant and an install with no signal still opens.
//    Cache-first, with a background refetch to keep the cache warm.
//
// Stock Management is served from the same origin (calgas.github.io), and
// Cache Storage is shared across an origin, not per app. Every cache this
// worker owns therefore carries CACHE_PREFIX, and cleanup only ever touches
// caches with that prefix — deleting "everything that isn't mine" would
// wipe Stock Management's offline copy each time this worker updated.
//
// Bump CACHE_VERSION whenever index.html / manifest.json / this file
// changes, so an already-installed client picks up the new shell instead
// of being stuck on an old cached one. Keep it in step with the
// app-version meta tag in index.html.
const CACHE_PREFIX = 'ele-tracker-shell-';
const CACHE_VERSION = CACHE_PREFIX + 'v5';
const APP_SHELL = ['./index.html', './manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {}) // don't block install if a shell asset is briefly unreachable
  );
  self.skipWaiting(); // don't wait for every open tab to close before a
                       // newly deployed version of this file takes over
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_VERSION)
          .map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim()) // take control of already-open tabs
  );
});

function isBackendRequest(url) {
  return url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com';
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Live batch data — always network, never cached or served from cache.
  if (isBackendRequest(url) || e.request.method !== 'GET') {
    e.respondWith(fetch(e.request));
    return;
  }

  // App shell & static assets — cache-first, refresh in the background so
  // the next visit has the latest version too.
  e.respondWith(
    caches.open(CACHE_VERSION).then((cache) =>
      cache.match(e.request).then((cached) => {
        const network = fetch(e.request)
          .then((resp) => {
            if (resp && resp.ok) cache.put(e.request, resp.clone());
            return resp;
          })
          .catch(() => cached); // offline with nothing fresh — fall back to cache if we have it
        return cached || network;
      })
    )
  );
});
