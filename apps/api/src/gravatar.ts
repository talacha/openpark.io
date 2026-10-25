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
  return `https://gravatar.com/avatar/${hash}?s=${px}&d=404&r=g`;
}
