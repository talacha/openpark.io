import { createHash } from 'node:crypto';

/**
 * Gravatar fallback for profile pictures.
 *
 * A person is identified by the SHA-256 of their email address, trimmed and lower-cased (Gravatar hashes the
 * address, never the raw text). The URL asks Gravatar for `d=404`, so an address without a profile answers
 * 404 instead of a generic placeholder; the web app then keeps the initials it already renders. Only the
 * hash leaves the deployment, never the address itself.
 *
 * @example
 * // Someone with a Gravatar gets their picture; everyone else keeps their initials.
 * const src = gravatarUrl(user.email); // null when the address is unusable
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const MAX_SIZE = 2048;
const DEFAULT_SIZE = 512;
const PROFILE_ENDPOINT = 'https://api.gravatar.com/v3/profiles';
const HIT_TTL_MS = 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 1000;

interface CacheEntry { url: string | null; expires: number }
const cache = new Map<string, CacheEntry>();

/** Test hook: forget every cached profile answer. */
export function resetGravatarCache(): void {
  cache.clear();
}

/** SHA-256 of the trimmed, lower-cased address, or null when there is no usable email. */
export function gravatarHash(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase() ?? '';
  if (!EMAIL_RE.test(normalized)) return null;
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * The Gravatar image URL for an address, or null when it is not a usable email.
 *
 * `size` is clamped to Gravatar's 1–2048 px range; 512 px matches the largest avatar we store ourselves.
 * `d=404` is what makes this a *fallback*: unrecognized addresses produce no image at all.
 */
export function gravatarUrl(email: string | null | undefined, size = DEFAULT_SIZE): string | null {
  const hash = gravatarHash(email);
  if (!hash) return null;
  const px = Number.isFinite(size) ? Math.min(Math.max(Math.trunc(size), 1), MAX_SIZE) : DEFAULT_SIZE;
  return `https://0.gravatar.com/avatar/${hash}?s=${px}&d=404&r=g`;
}

/** Only accept an avatar URL Gravatar itself could own; never let a profile response redirect the browser elsewhere. */
const AVATAR_URL_RE = /^https:\/\/(?:[a-z0-9-]+\.)?gravatar\.com\//i;

/**
 * Resolve the best available picture for an address.
 *
 * Without an API key this is the public avatar URL (`d=404`, so an unrecognized address yields nothing). With
 * `GRAVATAR_API_KEY`, the API asks the authenticated v3 profile endpoint server-side instead: a 200 confirms the
 * profile and returns its current avatar URL, a 404 means the address has no profile, and any other failure
 * falls back to the public URL so a Gravatar outage never blanks the screen. Answers are cached because `/v1/me`
 * runs on every app load; a miss is cached for less time than a hit.
 */
export async function gravatarAvatar(
  email: string | null | undefined,
  opts: { apiKey?: string; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<string | null> {
  const hash = gravatarHash(email);
  if (!hash) return null;
  const fallback = gravatarUrl(email);
  if (!opts.apiKey) return fallback;

  const now = opts.now ?? Date.now();
  const hit = cache.get(hash);
  if (hit && hit.expires > now) return hit.url;

  let url = fallback;
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${PROFILE_ENDPOINT}/${hash}`, {
      headers: { authorization: `Bearer ${opts.apiKey}`, accept: 'application/json' },
      // The public URL is a usable fallback, so do not let a slow Gravatar call hold up /v1/me.
      signal: AbortSignal.timeout(1000),
    });
    if (res.status === 200) {
      const body = (await res.json()) as { avatar_url?: unknown };
      url = typeof body.avatar_url === 'string' && AVATAR_URL_RE.test(body.avatar_url) ? body.avatar_url : fallback;
    } else if (res.status === 404) {
      url = null;
    }
  } catch {
    // Network error or timeout: the public URL is the same picture, just unauthenticated.
  }

  cache.set(hash, { url, expires: now + (url ? HIT_TTL_MS : MISS_TTL_MS) });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return url;
}
