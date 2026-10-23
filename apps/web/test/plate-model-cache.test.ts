import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ort = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('onnxruntime-web/wasm', () => ({
  env: { wasm: {} },
  InferenceSession: { create: ort.create },
}));

const MODELS = ['yolo-v9-t-384-license-plates-end2end.onnx', 'cct_s_v2_global.onnx'] as const;

async function sha256(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes as BufferSource)), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function setup(cached: boolean) {
  const bytes = Object.fromEntries(MODELS.map((name, i) => [name, new Uint8Array([i + 1, 2, 3, 4])])) as Record<(typeof MODELS)[number], Uint8Array>;
  const files = Object.fromEntries(await Promise.all(MODELS.map(async (name) => [name, { sha256: await sha256(bytes[name]) }])));
  const manifest = { ort: { mjs: 'ort-test.mjs', wasm: 'ort-test.wasm' }, files };
  const cache = {
    match: vi.fn(async (url: string) => cached ? new Response(bytes[url.split('/').pop() as (typeof MODELS)[number]] as BodyInit) : undefined),
    delete: vi.fn(),
    put: vi.fn(),
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/models/manifest.json') return Response.json(manifest);
    if (url === '/ort/ort-test.mjs') return new Response('export {}');
    throw new TypeError('offline');
  });
  vi.stubGlobal('caches', { open: vi.fn(async () => cache) });
  vi.stubGlobal('fetch', fetchMock);
  ort.create.mockImplementation(async () => ({ inputNames: ['input'], run: vi.fn() }));
  const { loadPlateModels } = await import('../src/alpr/loader.js');
  return { cache, fetchMock, loadPlateModels };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:ort-runtime'; } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('on-device plate model cache', () => {
  it('loads and verifies both cached models without downloading them again', async () => {
    const { cache, fetchMock, loadPlateModels } = await setup(true);
    await expect(loadPlateModels()).resolves.toMatchObject({ detector: expect.any(Object), ocr: expect.any(Object) });
    expect(cache.match).toHaveBeenCalledTimes(2);
    expect(ort.create).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain('/models/yolo-v9-t-384-license-plates-end2end.onnx');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain('/models/cct_s_v2_global.onnx');
  });

  it('fails instead of pretending to scan when no cached model is available offline', async () => {
    const { loadPlateModels } = await setup(false);
    await expect(loadPlateModels()).rejects.toThrow('offline');
  });
});
