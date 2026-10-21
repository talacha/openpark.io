// Fetches the plate-reading models from their official release assets, verifies the pinned SHA-256 (models.lock.json),
// and copies the ONNX Runtime WebAssembly files next to them. Everything lands in public/ (git-ignored), so no binaries
// are committed. Safe to run repeatedly: files that already match are skipped.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const lock = JSON.parse(readFileSync(new URL('models.lock.json', root), 'utf8'));
const outDir = new URL('public/models/', root);
const ortOut = new URL('public/ort/', root);
mkdirSync(outDir, { recursive: true }); mkdirSync(ortOut, { recursive: true });

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

for (const [name, f] of Object.entries(lock.files)) {
  const dest = new URL(name, outDir);
  if (existsSync(dest) && sha(readFileSync(dest)) === f.sha256) continue;
  process.stdout.write(`fetching ${name} (${(f.bytes / 1e6).toFixed(1)} MB)… `);
  const res = await fetch(f.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} from ${f.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== f.sha256) throw new Error(`${name}: SHA-256 mismatch (got ${sha(buf)}), refusing to use it`);
  writeFileSync(dest, buf);
  console.log('ok');
}

// The app verifies these hashes again in the browser before it trusts a model.
writeFileSync(new URL('NOTICE.md', outDir), `# Model licenses

- \`cct_s_v2_global.onnx\`: fast-plate-ocr (ankandrew), MIT.
- \`yolo-v9-t-384-license-plates-end2end.onnx\`: open-image-models (ankandrew); code MIT, YOLOv9 lineage GPL-3.0.
Downloaded at build time from the official release assets and pinned by SHA-256 in models.lock.json.
`);

// ONNX Runtime Web: the WebAssembly CPU build and its loader.
const dist = new URL('node_modules/onnxruntime-web/dist/', root);
// Versioned names: a new onnxruntime-web is a new URL, so cached browsers can never pair a new app with an old runtime.
const ortVersion = JSON.parse(readFileSync(new URL('node_modules/onnxruntime-web/package.json', root), 'utf8')).version;
const ort = { mjs: `ort-${ortVersion}-simd.mjs`, wasm: `ort-${ortVersion}-simd.wasm` };
copyFileSync(new URL('ort-wasm-simd-threaded.mjs', dist), new URL(ort.mjs, ortOut));
copyFileSync(new URL('ort-wasm-simd-threaded.wasm', dist), new URL(ort.wasm, ortOut));
writeFileSync(new URL('manifest.json', outDir), JSON.stringify({ ort, files: Object.fromEntries(Object.entries(lock.files).map(([n, f]) => [n, { sha256: f.sha256, bytes: f.bytes }])) }, null, 2));
console.log('models and onnxruntime-web assets ready in public/');
