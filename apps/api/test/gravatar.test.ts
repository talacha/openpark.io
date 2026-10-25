import { describe, expect, it } from 'vitest';
import { gravatarHash, gravatarUrl } from '../src/gravatar.js';

describe('gravatar fallback', () => {
  it('hashes the trimmed, lower-cased email with SHA-256', () => {
    // Known SHA-256 of alice@example.com, so the contract cannot drift silently.
    expect(gravatarHash('alice@example.com')).toBe('ff8d9819fc0e12bf0d24892e45987e249a28dce836a85cad60e28eaaa8c6d976');
    expect(gravatarHash('  Alice@Example.COM ')).toBe(gravatarHash('alice@example.com'));
    expect(gravatarHash('ALICE@EXAMPLE.COM')).toBe(gravatarHash('alice@example.com'));
  });

  it('returns null when there is no usable email', () => {
    expect(gravatarHash(null)).toBeNull();
    expect(gravatarHash(undefined)).toBeNull();
    expect(gravatarHash('   ')).toBeNull();
    expect(gravatarHash('not-an-email')).toBeNull();
    expect(gravatarHash('two words@example.com')).toBeNull();
    expect(gravatarUrl(null)).toBeNull();
    expect(gravatarUrl('not-an-email')).toBeNull();
  });

  it('asks for a 404 on a miss so the UI keeps its initials instead of a placeholder', () => {
    const url = gravatarUrl('alice@example.com')!;
    expect(url).toBe(`https://gravatar.com/avatar/${gravatarHash('alice@example.com')}?s=512&d=404&r=g`);
    expect(url).toContain('d=404');
  });

  it('clamps the requested size to the 1-2048 px range', () => {
    expect(gravatarUrl('alice@example.com', 80)).toContain('s=80&');
    expect(gravatarUrl('alice@example.com', 0)).toContain('s=1&');
    expect(gravatarUrl('alice@example.com', 99_999)).toContain('s=2048&');
    expect(gravatarUrl('alice@example.com', Number.NaN)).toContain('s=512&');
  });
});
