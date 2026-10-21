// App-shell cache so the attendant PWA opens offline. API calls are never cached:
// offline writes are queued in IndexedDB by the app and replayed with their Idempotency-Key.
const CACHE = 'openpark-shell-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/icon.svg', '/manifest.webmanifest'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== 'openpark-reader-v1' && k !== 'openpark-models-v1').map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/v1/') || url.origin !== location.origin) return;
  // The plate reader's WebAssembly runtime and models are large and never change under the same name: cache first,
  // so the reader starts instantly and works in a garage with no signal.
  if (url.pathname.startsWith('/ort/') || url.pathname.startsWith('/models/')) {
    e.respondWith(caches.open('openpark-reader-v1').then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/'))),
  );
});
