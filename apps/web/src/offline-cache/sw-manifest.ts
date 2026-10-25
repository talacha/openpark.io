/** SW manifest generation - Vite plugin implementation */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

/** Generate a deterministic version hash from all asset names and sizes */
export async function generateVersion(assets: { url: string; size: number }[]): Promise<string> {
  const sorted = [...assets].sort((a, b) => a.url.localeCompare(b.url));
  const input = sorted.map((a) => `${a.url}:${a.size}`).join('|');
  const hash = createHash('sha256').update(input).digest('hex');
  return hash;
}

/** Read a file's size in bytes */
export function getFileSize(path: string): number {
  return existsSync(path) ? readFileSync(path).byteLength : 0;
}

/** Collect all files under dist directory (excluding sw.js, sw-manifest.json, maps, and hidden files) */
export function collectDistAssets(distDir: string): { url: string; size: number }[] {
  const assets: { url: string; size: number }[] = [];
  
  function scan(dir: string, base: string = '') {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Skip hidden files and directories
      if (entry.name.startsWith('.')) continue;
      
      const fullPath = join(dir, entry.name);
      const urlPath = base ? `/${base}/${entry.name}` : `/${entry.name}`;
      
      if (entry.isDirectory()) {
        scan(fullPath, entry.name);
      } else if (entry.isFile()) {
        // Skip sw.js, sw-manifest.json, and source maps
        if (entry.name === 'sw.js' || entry.name === 'sw-manifest.json' || entry.name.endsWith('.map')) continue;
        
        assets.push({ url: urlPath, size: getFileSize(fullPath) });
      }
    }
  }
  
  scan(distDir);
  return assets;
}

/** Get ort files from dist directory */
export function getOrtFiles(distDir: string): string[] {
  const ortDir = join(distDir, 'ort');
  if (!existsSync(ortDir)) return [];
  
  const files: string[] = [];
  const entries = readdirSync(ortDir, { withFileTypes: true });
  for (const entry of entries) {
    // Skip hidden files
    if (entry.name.startsWith('.')) continue;
    
    if (entry.isFile() && (entry.name.endsWith('.mjs') || entry.name.endsWith('.wasm'))) {
      files.push(`/ort/${entry.name}`);
    }
  }
  return files.sort();
}

/** Get model files from dist directory */
export function getModelsFiles(distDir: string): string[] {
  const modelsDir = join(distDir, 'models');
  if (!existsSync(modelsDir)) return [];
  
  const files: string[] = [];
  const entries = readdirSync(modelsDir, { withFileTypes: true });
  for (const entry of entries) {
    // Skip hidden files
    if (entry.name.startsWith('.')) continue;
    
    if (entry.isFile()) {
      files.push(`/models/${entry.name}`);
    }
  }
  return files.sort();
}

/** Read ortVersion from package.json */
export function getOrtVersion(rootDir: string): string {
  const pkgPath = join(rootDir, 'node_modules', 'onnxruntime-web', 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Write manifest to dist/sw-manifest.json */
export function writeManifest(manifest: SwManifest, distDir: string): void {
  const manifestPath = resolve(distDir, 'sw-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

/** Manifest interface */
export interface SwManifest {
  version: string;
  assets: { url: string; size: number }[];
  ort: string[];
  models: string[];
  ortVersion: string;
}
