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
