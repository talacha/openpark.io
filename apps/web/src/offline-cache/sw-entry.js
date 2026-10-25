// Service Worker entry point for OpenPark PWA
// This file is bundled with esbuild to dist/sw.js for browser use

import {
  classifyRequest,
  contentTypeMatches,
  shouldCachePath,
  getAppCacheName,
  getModelsCacheName,
  getApiCacheName,
  sha256,
  buildApiCacheKey,
} from './sw-logic.js';

// @ts-ignore - manifest is injected at build time
const SW_MANIFEST = __SW_MANIFEST__ || {
  version: 'v1',
  assets: [],
  ort: [],
  models: [],
  ortVersion: 'unknown',
};

const APP_CACHE_NAME = getAppCacheName(SW_MANIFEST.version);
const MODELS_CACHE_NAME = getModelsCacheName(
  SW_MANIFEST.ort.length > 0 && SW_MANIFEST.models.length > 0
    ? sha256([...SW_MANIFEST.ort, ...SW_MANIFEST.models].join('|'))
    : 'v1'
);
const API_CACHE_NAME = getApiCacheName();

// Install handler
self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      try {
        const appCache = await caches.open(APP_CACHE_NAME);
        const assetsToCache = SW_MANIFEST.assets.filter(
          (a) => !a.url.startsWith('/models/') && !a.url.startsWith('/ort/') && !a.url.endsWith('.map')
        );

        if (assetsToCache.length === 0) {
          await appCache.addAll(['/', '/index.html', '/icon.svg', '/manifest.webmanifest']);
        } else {
          const failed = [];
          for (const asset of assetsToCache) {
            try {
              const res = await fetch(asset.url, { credentials: 'omit' });
              if (res.ok && contentTypeMatches(res, resolveDestination(asset.url))) {
                await appCache.put(asset.url, res.clone());
              }
            } catch {
              failed.push(asset.url);
            }
          }
          if (failed.length > 0) {
            throw new Error(`Failed to cache assets: ${failed.join(', ')}`);
          }
        }
      } catch (err) {
        console.error('SW install failed:', err);
      }
    })()
  );
});

// Activate handler
self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      
      for (const name of cacheNames) {
        if (name.startsWith('op-app-') && name !== APP_CACHE_NAME) {
          await caches.delete(name);
        }
      }
      
      const modelsCacheNames = cacheNames.filter(
        (n) => n.startsWith('op-models-') && n !== MODELS_CACHE_NAME
      );
      for (const name of modelsCacheNames) {
        await caches.delete(name);
      }

      await self.clients.claim();
    })()
  );
});

// Fetch handler
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  
  if (url.origin !== location.origin) return;
  if (e.request.method !== 'GET') return;
  if (e.request.headers.get('Accept') === 'text/event-stream') return;

  if (url.pathname.startsWith('/v1/')) {
    e.respondWith(handleApiRequest(e.request, url));
    return;
  }
  
  if (url.pathname.startsWith('/models/') || url.pathname.startsWith('/ort/')) {
    e.respondWith(cacheFirst(e.request, url, MODELS_CACHE_NAME));
    return;
  }
  
  if (url.pathname === '/sw-manifest.json') {
    e.respondWith(networkFirst(e.request, url, APP_CACHE_NAME, false));
    return;
  }
  
  if (e.request.mode === 'navigate' || e.request.destination === 'document') {
    e.respondWith(networkFirst(e.request, url, APP_CACHE_NAME, true));
    return;
  }
  
  e.respondWith(cacheFirst(e.request, url, APP_CACHE_NAME));
});

// API request handler
async function handleApiRequest(request, url) {
  if (
    url.pathname.startsWith('/v1/auth') ||
    url.pathname === '/v1/healthz' ||
    url.pathname.startsWith('/v1/alpr')
  ) {
    return fetch(request);
  }

  if (request.headers.get('Cache-Control') === 'no-store') {
    return fetch(request);
  }

  const cache = await caches.open(API_CACHE_NAME);
  const cacheKey = await buildApiCacheKey(request.headers, url.pathname);
  
  const cached = await cache.match(cacheKey);
  if (cached) {
    const result = new Response(cached.body, {
      status: cached.status,
      statusText: cached.statusText,
      headers: new Headers(cached.headers),
    });
    result.headers.set('X-From-Cache', '1');
    return result;
  }

  const response = await fetch(request);
  
  if (response.ok) {
    const cloned = response.clone();
    cloned.headers.set('X-From-Cache', '0');
    await cache.put(cacheKey, cloned);
  }

  return response;
}

// Network-first strategy
async function networkFirst(request, url, cacheName, fallbackToIndex) {
  const cache = await caches.open(cacheName);
  
  try {
    const controller = new AbortController();
    const timeoutMs = url.pathname.startsWith('/v1/') ? 4000 : 3000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    let response;
    try {
      response = await fetch(request, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
    
    if (response.ok) {
      if (request.mode === 'navigate' || request.destination === 'document') {
        await cache.put(request, response.clone());
      }
      return response;
    }
    
    if (response.status === 404) return response;
    
    const cached = await cache.match(request);
    if (cached) {
      const result = new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers: new Headers(cached.headers),
      });
      result.headers.set('X-From-Cache', '1');
      return result;
    }
    
    if (fallbackToIndex && (response.status >= 500 || response.type === 'error' || response.status === 0)) {
      const index = await cache.match('/');
      if (index) {
        const result = new Response(index.body, {
          status: index.status,
          statusText: index.statusText,
          headers: new Headers(index.headers),
        });
        result.headers.set('X-From-Cache', '1');
        return result;
      }
    }
    
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) {
      const result = new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers: new Headers(cached.headers),
      });
      result.headers.set('X-From-Cache', '1');
      return result;
    }
    
    if (fallbackToIndex) {
      const index = await cache.match('/');
      if (index) {
        const result = new Response(index.body, {
          status: index.status,
          statusText: index.statusText,
          headers: new Headers(index.headers),
        });
        result.headers.set('X-From-Cache', '1');
        return result;
      }
    }
    
    throw err;
  }
}

// Cache-first strategy
async function cacheFirst(request, url, cacheName) {
  const cache = await caches.open(cacheName);
  
  const cached = await cache.match(request);
  if (cached) {
    const result = new Response(cached.body, {
      status: cached.status,
      statusText: cached.statusText,
      headers: new Headers(cached.headers),
    });
    result.headers.set('X-From-Cache', '1');
    return result;
  }
  
  try {
    const response = await fetch(request, { credentials: 'omit' });
    
    if (response.ok && shouldCachePath(url.pathname)) {
      const dest = resolveDestination(request.url);
      if (contentTypeMatches(response, dest)) {
        await cache.put(request, response.clone());
      }
    }
    
    return response;
  } catch (err) {
    const dest = resolveDestination(request.url);
    if (dest === 'script' || dest === 'style') {
      return new Response(null, { status: 503, statusText: 'Offline' });
    }
    throw err;
  }
}

// Message handler
self.addEventListener('message', (e) => {
  if (e.data === undefined || !e.data || typeof e.data.type !== 'string') return;

  switch (e.data.type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
      
    case 'PRECACHE_MODELS':
      e.waitUntil(precacheModels());
      if (e.ports && e.ports.length > 0) {
        e.ports[0].postMessage({ type: 'PRECACHE_MODELS_DONE' });
      } else if (e.source && 'postMessage' in e.source) {
        e.source.postMessage({ type: 'PRECACHE_MODELS_DONE' });
      }
      break;
      
    case 'CLEAR_API_CACHE':
      e.waitUntil(clearApiCache());
      if (e.ports && e.ports.length > 0) {
        e.ports[0].postMessage({ type: 'CLEAR_API_CACHE_DONE' });
      } else if (e.source && 'postMessage' in e.source) {
        e.source.postMessage({ type: 'CLEAR_API_CACHE_DONE' });
      }
      break;
  }
});

async function precacheModels() {
  const cache = await caches.open(MODELS_CACHE_NAME);
  
  for (const url of SW_MANIFEST.ort) {
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (res.ok) {
        await cache.put(url, res.clone());
      }
    } catch {}
  }
  
  for (const url of SW_MANIFEST.models) {
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (res.ok) {
        await cache.put(url, res.clone());
      }
    } catch {}
  }
}

async function clearApiCache() {
  try {
    await caches.delete(API_CACHE_NAME);
  } catch {}
}

function resolveDestination(url) {
  const pathname = new URL(url, location.href).pathname;
  
  if (pathname.endsWith('.js') || pathname.endsWith('.mjs')) return 'script';
  if (pathname.endsWith('.css')) return 'style';
  if (pathname.endsWith('.html') || pathname === '/') return 'document';
  if (pathname.endsWith('.png') || pathname.endsWith('.jpg') || pathname.endsWith('.svg')) return 'image';
  if (pathname.endsWith('.json')) return 'manifest';
  
  return '';
}
