/** Service Worker logic helpers - extractable for testing */
export type Strategy = 'network-first' | 'cache-first';

/** Classify a request to determine caching strategy */
export function classifyRequest(url: URL, destination: RequestDestination): { strategy: Strategy; shouldCache: boolean } {
  // Navigate requests use network-first with fallback
  if (destination === 'document') {
    return { strategy: 'network-first', shouldCache: true };
  }
  
  // Other destinations use cache-first
  return { strategy: 'cache-first', shouldCache: true };
}

/** Build cache key for API requests - includes tenant and auth subject hash for isolation */
export async function buildApiCacheKey(headers: Headers, path: string): Promise<string> {
  const tenant = headers.get('x-tenant') ?? 'unknown';
  
  // Get auth header and hash the subject
  const authHeader = headers.get('authorization') ?? '';
  const authHash = await sha256(authHeader);
  
  return `api:${tenant}:${authHash}:${path}`;
}

/** Build cache key for tenant data (no auth dependency) */
export function buildTenantCacheKey(tenant: string, path: string): string {
  return `api:${tenant}:${path}`;
}

/** SHA-256 hash helper */
export async function sha256(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buf);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Check if a response's content-type matches the request destination */
export function contentTypeMatches(response: Response, destination: RequestDestination): boolean {
  const contentType = response.headers.get('content-type') ?? '';
  
  switch (destination) {
    case 'script':
    case 'worker':
      return contentType.includes('javascript') || contentType.includes('module');
    case 'style':
      return contentType.includes('css');
    case 'document':
      return contentType.includes('text/html');
    case 'image':
      return contentType.startsWith('image/');
    case 'video':
      return contentType.startsWith('video/');
    case 'audio':
      return contentType.startsWith('audio/');
    case 'font':
      return contentType.includes('font') || contentType.includes('octet-stream');
    case 'manifest':
      return contentType.includes('manifest');
    case 'xslt':
      return contentType.includes('xml');
    default:
      return true; // Permissive for unknown destinations
  }
}

/** Check if a path should be cached at all */
export function shouldCachePath(path: string): boolean {
  // Never cache auth endpoints
  if (path.startsWith('/v1/auth')) return false;
  
  // Never cache health check
  if (path === '/v1/healthz') return false;
  
  // Never cache ALPR endpoints
  if (path.startsWith('/v1/alpr')) return false;
  
  // Never cache paths with no-store
  // (checked on response, not request)
  
  return true;
}

/** Get cache name for app assets */
export function getAppCacheName(version: string): string {
  return `op-app-${version}`;
}

/** Get cache name for models */
export function getModelsCacheName(modelsSha: string): string {
  return `op-models-${modelsSha}`;
}

/** Get cache name for API responses */
export function getApiCacheName(): string {
  return 'op-api-v1';
}
