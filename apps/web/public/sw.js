// App-shell cache so the attendant PWA opens offline. API calls are never cached:
// offline writes are queued in IndexedDB by the app and replayed with their Idempotency-Key.
const CACHE = 'openpark-shell-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/icon.svg', '/manifest.webmanifest'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== 'openpark-reader-v2' && k !== 'openpark-models-v1').map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/v1/') || url.origin !== location.origin) return;
  // The plate reader's WebAssembly runtime and models are large and never change under the same name: cache first,
  // so the reader starts instantly and works in a garage with no signal.
  // The model files are cached (and hash-checked) by the app itself; the service worker would only keep a second copy.
  if (url.pathname.startsWith('/models/') && url.pathname !== '/models/manifest.json') return;
  if (url.pathname.startsWith('/ort/') || url.pathname === '/models/manifest.json') {
    // The manifest says which runtime files and model hashes are current, so it is network-first; the big files it names are
    // immutable (versioned names, hash-checked by the app) and cached first. Anything that is not a real file is never cached.
    const fresh = url.pathname === '/models/manifest.json';
    e.respondWith(caches.open('openpark-reader-v2').then(async (c) => {
      const hit = await c.match(e.request);
      if (hit && !fresh) return hit;
      try {
        const res = await fetch(e.request);
        const type = res.headers.get('content-type') ?? '';
        if (res.ok && !type.includes('text/html')) c.put(e.request, res.clone());
        return res;
      } catch (err) { if (hit) return hit; throw err; }
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
