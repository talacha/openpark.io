/** SW manifest generation tests */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateVersion, getFileSize, collectDistAssets, getOrtVersion, getOrtFiles, getModelsFiles, writeManifest } from '../src/offline-cache/sw-manifest.js';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

// Create a temporary test directory
const testDir = resolve(__dirname, 'test-dist');
const testDist = resolve(testDir, 'dist');
const testRoot = resolve(testDir, 'root');

beforeEach(() => {
  // Clean up before each test
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
  mkdirSync(testDist, { recursive: true });
  mkdirSync(resolve(testRoot, 'node_modules', 'onnxruntime-web'), { recursive: true });
});

afterEach(() => {
  // Clean up after each test
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe('generateVersion', () => {
  it('should produce consistent hash', async () => {
    const assets = [
      { url: '/app.js', size: 1000 },
      { url: '/style.css', size: 500 },
    ];
    const hash1 = await generateVersion(assets);
    const hash2 = await generateVersion(assets);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64);
  });

  it('should produce different hash for different assets', async () => {
    const assets1 = [{ url: '/app.js', size: 1000 }];
    const assets2 = [{ url: '/app.js', size: 2000 }];
    expect(await generateVersion(assets1)).not.toBe(await generateVersion(assets2));
  });

  it('should produce same hash for different order (sorted)', async () => {
    const assets1 = [{ url: '/a.js', size: 100 }, { url: '/b.js', size: 200 }];
    const assets2 = [{ url: '/b.js', size: 200 }, { url: '/a.js', size: 100 }];
    expect(await generateVersion(assets1)).toBe(await generateVersion(assets2));
  });
});

describe('getFileSize', () => {
  it('should return file size', () => {
    const filePath = resolve(testDist, 'test.txt');
    writeFileSync(filePath, 'hello world');
    expect(getFileSize(filePath)).toBe(11);
  });

  it('should return 0 for non-existent file', () => {
    expect(getFileSize(resolve(testDist, 'nonexistent.txt'))).toBe(0);
  });
});

describe('getOrtVersion', () => {
  it('should read version from package.json', () => {
    const pkgPath = resolve(testRoot, 'node_modules', 'onnxruntime-web', 'package.json');
    writeFileSync(pkgPath, JSON.stringify({ version: '1.30.0' }));
    expect(getOrtVersion(testRoot)).toBe('1.30.0');
  });

  it('should return unknown when file missing', () => {
    expect(getOrtVersion(resolve(testDir, 'nonexistent'))).toBe('unknown');
  });
});

describe('getOrtFiles', () => {
  it('should list ort files', () => {
    mkdirSync(resolve(testDist, 'ort'), { recursive: true });
    writeFileSync(resolve(testDist, 'ort', 'ort-1.30.0-simd.mjs'), '');
    writeFileSync(resolve(testDist, 'ort', 'ort-1.30.0-simd.wasm'), '');
    
    const files = getOrtFiles(testDist);
    expect(files).toEqual(['/ort/ort-1.30.0-simd.mjs', '/ort/ort-1.30.0-simd.wasm']);
  });

  it('should return empty when ort directory missing', () => {
    expect(getOrtFiles(testDist)).toEqual([]);
  });
});

describe('getModelsFiles', () => {
  it('should list model files', () => {
    mkdirSync(resolve(testDist, 'models'), { recursive: true });
    writeFileSync(resolve(testDist, 'models', 'model1.onnx'), '');
    writeFileSync(resolve(testDist, 'models', 'model2.onnx'), '');
    
    const files = getModelsFiles(testDist);
    expect(files).toEqual(['/models/model1.onnx', '/models/model2.onnx']);
  });

  it('should return empty when models directory missing', () => {
    expect(getModelsFiles(testDist)).toEqual([]);
  });
});

describe('writeManifest', () => {
  it('should write manifest to file', () => {
    const manifest = {
      version: 'test123',
      assets: [{ url: '/app.js', size: 100 }],
      ort: [],
      models: [],
      ortVersion: 'unknown',
    };
    writeManifest(manifest, testDist);
    
    const manifestPath = resolve(testDist, 'sw-manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const content = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(content.version).toBe('test123');
  });
});

describe('collectDistAssets', () => {
  it('should collect all assets excluding sw.js and maps', () => {
    mkdirSync(resolve(testDist, 'assets'), { recursive: true });
    mkdirSync(resolve(testDist, 'models'), { recursive: true });
    mkdirSync(resolve(testDist, 'ort'), { recursive: true });
    
    writeFileSync(resolve(testDist, 'index.html'), '');
    writeFileSync(resolve(testDist, 'app.js'), '');
    writeFileSync(resolve(testDist, 'app.js.map'), '');
    writeFileSync(resolve(testDist, 'sw.js'), '');
    writeFileSync(resolve(testDist, 'sw-manifest.json'), '');
    writeFileSync(resolve(testDist, 'assets', 'style.css'), '');
    writeFileSync(resolve(testDist, 'models', 'model.onnx'), '');
    writeFileSync(resolve(testDist, 'ort', 'ort.mjs'), '');
    
    const assets = collectDistAssets(testDist);
    const urls = assets.map(a => a.url);
    
    // Should include these
    expect(urls).toContain('/index.html');
    expect(urls).toContain('/app.js');
    expect(urls).toContain('/assets/style.css');
    expect(urls).toContain('/models/model.onnx');
    expect(urls).toContain('/ort/ort.mjs');
    
    // Should exclude these
    expect(urls).not.toContain('/app.js.map');
    expect(urls).not.toContain('/sw.js');
    expect(urls).not.toContain('/sw-manifest.json');
  });

  it('should skip hidden files (starting with dot)', () => {
    writeFileSync(resolve(testDist, '.gitignore'), '');
    writeFileSync(resolve(testDist, 'app.js'), '');
    
    const assets = collectDistAssets(testDist);
    const urls = assets.map(a => a.url);
    
    expect(urls).not.toContain('/.gitignore');
    expect(urls).toContain('/app.js');
  });
});
