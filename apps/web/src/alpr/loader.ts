import type { OrtLike, OrtSessionLike } from './reader.js';

const CACHE = 'openpark-models-v1';
const DET = 'yolo-v9-t-384-license-plates-end2end.onnx', OCR = 'cct_s_v2_global.onnx';

async function sha256(buf: ArrayBuffer) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Fetch a model once, keep it in Cache Storage (so garages without signal still work), and refuse it unless its SHA-256 matches the manifest. */
async function modelBytes(name: string, want: string): Promise<ArrayBuffer> {
  const url = `/models/${name}`;
  let cache: Cache | null = null;
  try { cache = await caches.open(CACHE); } catch { /* private mode: no offline copy, still works online */ }
  const hit = await cache?.match(url);
  if (hit) { const b = await hit.arrayBuffer(); if ((await sha256(b)) === want) return b; await cache?.delete(url); }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model ${name}: HTTP ${res.status}`);
  const b = await res.arrayBuffer();
  if ((await sha256(b)) !== want) throw new Error(`model ${name}: checksum mismatch`);
  try { await cache?.put(url, new Response(b, { headers: { 'content-type': 'application/octet-stream' } })); } catch { /* quota */ }
  return b;
}

let loading: Promise<{ ort: OrtLike; detector: OrtSessionLike; ocr: OrtSessionLike }> | null = null;

/** Load onnxruntime-web (WebAssembly) and both models once per page. Rejects if the models are not deployed. */
export function loadPlateModels() {
  loading ??= (async () => {
    const [ort, manifest] = await Promise.all([
      import('onnxruntime-web/wasm'),
      fetch('/models/manifest.json').then((r) => { if (!r.ok) throw new Error('plate models are not installed'); return r.json() as Promise<{ ort: { mjs: string; wasm: string }; files: Record<string, { sha256: string }> }>; }),
    ]);
    // The runtime files carry the library version in their names (see scripts/fetch-models.mjs). In production they are served as-is;
    // Vite's dev server refuses to import files from public/, so there the script is loaded through a blob URL.
    const wasm = `${location.origin}/ort/${manifest.ort.wasm}`;
    if (import.meta.env.DEV) {
      const js = await (await fetch(`/ort/${manifest.ort.mjs}`)).text();
      ort.env.wasm.wasmPaths = { mjs: URL.createObjectURL(new Blob([js], { type: 'text/javascript' })), wasm };
    } else ort.env.wasm.wasmPaths = { mjs: `${location.origin}/ort/${manifest.ort.mjs}`, wasm };
    ort.env.wasm.numThreads = 1; // multi-threading needs cross-origin isolation, which would break third-party embeds
    const make = async (name: string) => (await ort.InferenceSession.create(await modelBytes(name, manifest.files[name]!.sha256), { executionProviders: ['wasm'] })) as unknown as OrtSessionLike;
    const [detector, ocr] = await Promise.all([make(DET), make(OCR)]);
    return { ort: ort as unknown as OrtLike, detector, ocr };
  })();
  loading.catch(() => { loading = null; }); // allow a retry after a failure
  return loading;
}

export async function loadReader() {
  const { createReader } = await import('./reader.js');
  const m = await loadPlateModels();
  return createReader(m.ort, m.detector, m.ocr);
}

/** Check if models are ready by verifying cache presence */
async function checkModelsInCache(cache: Cache, manifest: any): Promise<boolean> {
  try {
    // Check ORT files
    for (const url of [`/ort/${manifest.ort.mjs}`, `/ort/${manifest.ort.wasm}`]) {
      const res = await cache.match(url);
      if (!res || !res.ok) return false;
    }
    // Check model files
    for (const name of Object.keys(manifest.files)) {
      const res = await cache.match(`/models/${name}`);
      if (!res || !res.ok) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Track ALPR readiness state
let readinessState: 'ready' | 'downloading' | 'unavailable' = 'unavailable';
const readinessListeners = new Set<(status: 'ready' | 'downloading' | 'unavailable') => void>();

/** Prefetch models via the service worker for offline use */
export async function prefetchReader(): Promise<void> {
  // If we have a service worker controller, ask it to precache
  const controller = navigator.serviceWorker.controller;
  if (controller) {
    try {
      const channel = new MessageChannel();
      const promise = new Promise<void>((resolve, reject) => {
        channel.port1.onmessage = (e) => {
          if (e.data?.type === 'PRECACHE_MODELS_DONE') {
            resolve();
          }
        };
        
        controller.postMessage({ type: 'PRECACHE_MODELS' }, [channel.port2]);
        
        // Timeout after 30 seconds
        setTimeout(() => {
          channel.port1.close();
          reject(new Error('Message timeout'));
        }, 30000);
      });
      
      await promise;
      // Update state after successful precache
      readinessState = 'ready';
      readinessListeners.forEach(fn => fn('ready'));
      return;
    } catch {
      // Fallback to direct fetch
    }
  }

  // Fallback: fetch models directly and put in cache
  try {
    const [ort, manifest] = await Promise.all([
      import('onnxruntime-web/wasm'),
      fetch('/models/manifest.json').then(r => { if (!r.ok) throw new Error('plate models not installed'); return r.json() as Promise<{ ort: { mjs: string; wasm: string }; files: Record<string, { sha256: string }> }>; }),
    ]);

    const cache = await caches.open(CACHE);
    
    // Update state to downloading
    readinessState = 'downloading';
    readinessListeners.forEach(fn => fn('downloading'));
    
    // ORT files
    for (const url of [`/ort/${manifest.ort.mjs}`, `/ort/${manifest.ort.wasm}`]) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          await cache.put(url, res.clone());
        }
      } catch {
        // Ignore individual failures
      }
    }

    // Model files
    for (const [name, info] of Object.entries(manifest.files)) {
      try {
        const res = await fetch(`/models/${name}`);
        if (res.ok) {
          await cache.put(`/models/${name}`, res.clone());
        }
      } catch {
        // Ignore individual failures
      }
    }
    
    // Check if all models are now present
    const allPresent = await checkModelsInCache(cache, manifest);
    readinessState = allPresent ? 'ready' : 'unavailable';
    readinessListeners.forEach(fn => fn(readinessState));
  } catch {
    readinessState = 'unavailable';
    readinessListeners.forEach(fn => fn('unavailable'));
  }
}

/** Get current models readiness status */
export function readerReadiness(): 'ready' | 'downloading' | 'unavailable' {
  return readinessState;
}

/** Subscribe to readiness changes */
export function subscribeReaderReadiness(fn: (status: 'ready' | 'downloading' | 'unavailable') => void): () => void {
  fn(readinessState); // Call immediately with current state
  readinessListeners.add(fn);
  return () => readinessListeners.delete(fn);
}
