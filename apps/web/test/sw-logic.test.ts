/** SW logic tests */
import { describe, it, expect } from 'vitest';
import { classifyRequest, contentTypeMatches, shouldCachePath, sha256, buildApiCacheKey, getAppCacheName, getModelsCacheName, getApiCacheName } from '../src/offline-cache/sw-logic';

describe('classifyRequest', () => {
  it('should return network-first for navigate requests (document destination)', () => {
    const url = new URL('https://example.com/');
    const result = classifyRequest(url, 'document');
    expect(result.strategy).toBe('network-first');
    expect(result.shouldCache).toBe(true);
  });

  it('should return cache-first for script requests', () => {
    const url = new URL('https://example.com/app.js');
    const result = classifyRequest(url, 'script');
    expect(result.strategy).toBe('cache-first');
    expect(result.shouldCache).toBe(true);
  });

  it('should return cache-first for style requests', () => {
    const url = new URL('https://example.com/style.css');
    const result = classifyRequest(url, 'style');
    expect(result.strategy).toBe('cache-first');
  });

  it('should return cache-first for wasm requests', () => {
    const url = new URL('https://example.com/model.wasm');
    const result = classifyRequest(url, 'wasm');
    expect(result.strategy).toBe('cache-first');
  });

  it('should return cache-first for empty destination', () => {
    const url = new URL('https://example.com/data.json');
    const result = classifyRequest(url, 'empty');
    expect(result.strategy).toBe('cache-first');
  });
});

describe('contentTypeMatches', () => {
  it('should match JavaScript for script destination', () => {
    const response = new Response('', { headers: { 'content-type': 'application/javascript' } });
    expect(contentTypeMatches(response, 'script')).toBe(true);
  });

  it('should match module for script destination', () => {
    const response = new Response('', { headers: { 'content-type': 'application/javascript; charset=utf-8' } });
    expect(contentTypeMatches(response, 'script')).toBe(true);
  });

  it('should match CSS for style destination', () => {
    const response = new Response('', { headers: { 'content-type': 'text/css' } });
    expect(contentTypeMatches(response, 'style')).toBe(true);
  });

  it('should match HTML for document destination', () => {
    const response = new Response('', { headers: { 'content-type': 'text/html' } });
    expect(contentTypeMatches(response, 'document')).toBe(true);
  });

  it('should match images', () => {
    const response = new Response('', { headers: { 'content-type': 'image/png' } });
    expect(contentTypeMatches(response, 'image')).toBe(true);
  });

  it('should match webp images', () => {
    const response = new Response('', { headers: { 'content-type': 'image/webp' } });
    expect(contentTypeMatches(response, 'image')).toBe(true);
  });

  it('should match SVG as image', () => {
    const response = new Response('', { headers: { 'content-type': 'image/svg+xml' } });
    expect(contentTypeMatches(response, 'image')).toBe(true);
  });

  it('should match font content types', () => {
    const response = new Response('', { headers: { 'content-type': 'font/woff2' } });
    expect(contentTypeMatches(response, 'font')).toBe(true);
  });

  it('should match unknown destination', () => {
    const response = new Response('', { headers: { 'content-type': 'application/octet-stream' } });
    expect(contentTypeMatches(response, 'unknown' as RequestDestination)).toBe(true);
  });
});

describe('shouldCachePath', () => {
  it('should not cache auth paths', () => {
    expect(shouldCachePath('/v1/auth/login')).toBe(false);
    expect(shouldCachePath('/v1/auth/login')).toBe(false);
  });

  it('should not cache healthz', () => {
    expect(shouldCachePath('/v1/healthz')).toBe(false);
  });

  it('should not cache alpr paths', () => {
    expect(shouldCachePath('/v1/alpr/read')).toBe(false);
    expect(shouldCachePath('/v1/alpr/status')).toBe(false);
  });

  it('should cache other v1 paths', () => {
    expect(shouldCachePath('/v1/sessions')).toBe(true);
    expect(shouldCachePath('/v1/sites')).toBe(true);
  });

  it('should cache static assets', () => {
    expect(shouldCachePath('/assets/app.js')).toBe(true);
    expect(shouldCachePath('/index.html')).toBe(true);
  });
});

describe('sha256', () => {
  it('should produce consistent hash', async () => {
    const hash1 = await sha256('test');
    const hash2 = await sha256('test');
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64); // 32 bytes = 64 hex chars
  });

  it('should produce different hash for different input', async () => {
    const hash1 = await sha256('test1');
    const hash2 = await sha256('test2');
    expect(hash1).not.toBe(hash2);
  });

  it('should produce correct hash for empty string', async () => {
    const hash = await sha256('');
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('buildApiCacheKey', () => {
  it('should build key with tenant', async () => {
    const headers = new Headers({ 'x-tenant': 'tenant-123' });
    const key = await buildApiCacheKey(headers, '/v1/sessions');
    expect(key).toContain('tenant-123');
    expect(key).toContain('/v1/sessions');
  });

  it('should use unknown tenant when header missing', async () => {
    const headers = new Headers();
    const key = await buildApiCacheKey(headers, '/v1/sessions');
    expect(key).toContain('unknown');
  });

  it('should hash auth header for isolation', async () => {
    const headers1 = new Headers({ 'x-tenant': 'tenant-123', 'authorization': 'Bearer token1' });
    const headers2 = new Headers({ 'x-tenant': 'tenant-123', 'authorization': 'Bearer token2' });
    
    const key1 = await buildApiCacheKey(headers1, '/v1/sessions');
    const key2 = await buildApiCacheKey(headers2, '/v1/sessions');
    
    expect(key1).not.toBe(key2);
  });

  it('should produce same key for same inputs', async () => {
    const headers = new Headers({ 'x-tenant': 'tenant-123', 'authorization': 'Bearer token' });
    
    const key1 = await buildApiCacheKey(headers, '/v1/sessions');
    const key2 = await buildApiCacheKey(headers, '/v1/sessions');
    
    expect(key1).toBe(key2);
  });
});

describe('cache names', () => {
  it('should return correct app cache name', () => {
    expect(getAppCacheName('v1')).toBe('op-app-v1');
    expect(getAppCacheName('abc123')).toBe('op-app-abc123');
  });

  it('should return correct models cache name', () => {
    expect(getModelsCacheName('sha123')).toBe('op-models-sha123');
  });

  it('should return correct API cache name', () => {
    expect(getApiCacheName()).toBe('op-api-v1');
  });
});
