import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gravatarAvatar, gravatarHash, gravatarUrl, resetGravatarCache } from '../src/gravatar.js';

const HASH = 'ff8d9819fc0e12bf0d24892e45987e249a28dce836a85cad60e28eaaa8c6d976';

beforeEach(() => { resetGravatarCache(); });

describe('gravatar fallback', () => {
  it('hashes the trimmed, lower-cased email with SHA-256', () => {
    // Known SHA-256 of alice@example.com, so the contract cannot drift silently.
    expect(gravatarHash('alice@example.com')).toBe(HASH);
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
    expect(url).toBe(`https://0.gravatar.com/avatar/${HASH}?s=512&d=404&r=g`);
    expect(url).toContain('d=404');
  });

  it('clamps the requested size to the 1-2048 px range', () => {
    expect(gravatarUrl('alice@example.com', 80)).toContain('s=80&');
    expect(gravatarUrl('alice@example.com', 0)).toContain('s=1&');
    expect(gravatarUrl('alice@example.com', 99_999)).toContain('s=2048&');
    expect(gravatarUrl('alice@example.com', Number.NaN)).toContain('s=512&');
  });
});

describe('gravatar profile lookup', () => {
  const ok = (avatarUrl: string) =>
    vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ avatar_url: avatarUrl }), { status: 200, headers: { 'content-type': 'application/json' } }));

  it('uses the public URL and makes no request when no API key is configured', async () => {
    const fetchImpl = vi.fn();
    const url = await gravatarAvatar('alice@example.com', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(url).toBe(gravatarUrl('alice@example.com'));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('asks the v3 profile endpoint with a Bearer token and returns its avatar URL', async () => {
    const avatar = `https://0.gravatar.com/avatar/${HASH}?s=512`;
    const fetchImpl = ok(avatar);
    expect(await gravatarAvatar('  Alice@Example.COM ', { apiKey: 'test-key', fetchImpl, now: 1 })).toBe(avatar);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [target, init] = fetchImpl.mock.calls[0]!;
    expect(target).toBe(`https://api.gravatar.com/v3/profiles/${HASH}`);
    expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key', accept: 'application/json' });
  });

  it('returns null for a 404 so the screen keeps its initials', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 404 }));
    expect(await gravatarAvatar('alice@example.com', { apiKey: 'test-key', fetchImpl, now: 1 })).toBeNull();
  });

  it('falls back to the public URL on a server error, timeout, or an untrusted avatar host', async () => {
    const failing = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 500 }));
    expect(await gravatarAvatar('alice@example.com', { apiKey: 'k', fetchImpl: failing, now: 1 })).toBe(gravatarUrl('alice@example.com'));

    resetGravatarCache();
    const thrown = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { throw new Error('down'); });
    expect(await gravatarAvatar('alice@example.com', { apiKey: 'k', fetchImpl: thrown, now: 1 })).toBe(gravatarUrl('alice@example.com'));

    resetGravatarCache();
    const untrusted = ok('https://evil.example/avatar.png');
    expect(await gravatarAvatar('alice@example.com', { apiKey: 'k', fetchImpl: untrusted, now: 1 })).toBe(gravatarUrl('alice@example.com'));
  });

  it('caches an answer so /v1/me does not call Gravatar on every load', async () => {
    const avatar = `https://0.gravatar.com/avatar/${HASH}?s=512`;
    const fetchImpl = ok(avatar);
    await gravatarAvatar('alice@example.com', { apiKey: 'k', fetchImpl, now: 1_000 });
    expect(await gravatarAvatar('alice@example.com', { apiKey: 'k', fetchImpl, now: 2_000 })).toBe(avatar);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
