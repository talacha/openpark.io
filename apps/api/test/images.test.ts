import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imageAsset, imageKey } from '../src/images.js';
import { harness, signup, tenantId as lookupTenantId, type Harness, type Tenant } from './helpers.js';

let h: Harness;
let owner: Tenant;
let tenant: string;

beforeAll(async () => {
  h = await harness();
  owner = await signup(h.app);
  tenant = await lookupTenantId(owner.slug);
});

afterAll(async () => {
  await h.close();
});

function image(width = 2400, height = 1800, background = '#336699'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } }).jpeg({ quality: 100 }).toBuffer();
}

const store = (identity: Parameters<typeof imageAsset>[2], data: Buffer) =>
  h.app.db.withTenant(tenant, (db) => imageAsset(db, tenant, identity, data));

const load = (identity: Parameters<typeof imageAsset>[2]) =>
  h.app.db.withTenant(tenant, (db) => imageAsset(db, tenant, identity));

describe('image identity hashing', () => {
  it('normalises email subjects so casing and whitespace cannot fork an avatar', () => {
    const a = imageKey(tenant, { type: 'avatar', subject: '  Alice@Example.COM ' });
    const b = imageKey(tenant, { type: 'AVATAR', subject: 'alice@example.com' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toContain('alice');
  });

  it('normalises plate subjects so separators and casing cannot fork enforcement evidence', () => {
    const a = imageKey(tenant, { type: 'immobilization', subject: 'abc-123', region: 'mx-cmx' });
    const b = imageKey(tenant, { type: 'immobilization', subject: ' ABC 123 ', region: 'MX-CMX' });
    expect(a).toBe(b);
  });

  it('separates assets by event, department, type and tenant', () => {
    const base = { type: 'violation', subject: 'ABC-123', region: 'MX-CMX' } as const;
    const key = imageKey(tenant, base);
    expect(imageKey(tenant, { ...base, event: 'overstay' })).not.toBe(key);
    expect(imageKey(tenant, { ...base, event: 'wrong_slot' })).not.toBe(key);
    expect(imageKey(tenant, { ...base, departmentNumber: '7' })).not.toBe(key);
    expect(imageKey(tenant, { ...base, departmentNumber: '7' })).toBe(imageKey(tenant, { ...base, departmentNumber: 7 }));
    expect(imageKey(tenant, { ...base, type: 'immobilization' })).not.toBe(key);
    expect(imageKey('00000000-0000-0000-0000-000000000000', base)).not.toBe(key);
  });

  it('rejects an empty subject and an unsafe type', () => {
    expect(() => imageKey(tenant, { type: 'avatar', subject: '   ' })).toThrow(/subject/);
    expect(() => imageKey(tenant, { type: 'Avatar/../../etc', subject: 'a@b.c' })).toThrow(/type/);
  });
});

describe('imageAsset', () => {
  it('optimises to a bounded WebP and records the content hash', async () => {
    const input = await image();
    const identity = { type: 'avatar', subject: 'optimise@example.com' } as const;
    const stored = await store(identity, input);

    expect(stored).not.toBeNull();
    expect(stored!.mime).toBe('image/webp');
    expect(stored!.width).toBe(512);
    expect(stored!.height).toBe(384);
    expect(stored!.bytes).toBeLessThan(input.length);
    expect(stored!.sha256).toBe(createHash('sha256').update(stored!.data).digest('hex'));
    expect(stored!.key).toBe(imageKey(tenant, identity));
    expect(stored!.created).toBe(true);
  });

  it('is idempotent: the same identity and bytes reuse the row without touching updatedAt', async () => {
    const input = await image();
    const identity = { type: 'avatar', subject: 'idempotent@example.com' } as const;

    const first = await store(identity, input);
    const second = await store(identity, input);

    expect(second!.key).toBe(first!.key);
    expect(second!.created).toBe(false);
    expect(second!.sha256).toBe(first!.sha256);
    expect(second!.updatedAt.getTime()).toBe(first!.updatedAt.getTime());
  });

  it('replaces the bytes in place when the same identity gets a new image', async () => {
    const identity = { type: 'avatar', subject: 'replace@example.com' } as const;
    const first = await store(identity, await image(2400, 1800, '#336699'));
    const second = await store(identity, await image(2400, 1800, '#993333'));

    expect(second!.key).toBe(first!.key);
    expect(second!.created).toBe(false);
    expect(second!.sha256).not.toBe(first!.sha256);
    expect(second!.updatedAt.getTime()).toBeGreaterThanOrEqual(first!.updatedAt.getTime());

    const loaded = await load(identity);
    expect(loaded!.data.equals(second!.data)).toBe(true);
  });

  it('retrieves by identity and returns null for an unknown subject', async () => {
    const identity = { type: 'avatar', subject: 'retrieve@example.com' } as const;
    const stored = await store(identity, await image());

    const loaded = await load(identity);
    expect(loaded).not.toBeNull();
    expect(loaded!.key).toBe(stored!.key);
    expect(loaded!.data.equals(stored!.data)).toBe(true);

    expect(await load({ type: 'avatar', subject: 'nobody@example.com' })).toBeNull();
  });

  it('keys enforcement evidence by plate, so a fresh photo of the same vehicle replaces the old one', async () => {
    const photo = await image(3000, 2000);
    const first = await store({ type: 'immobilization', subject: 'ABC-123', region: 'MX-CMX', event: 'immobilization' }, photo);
    const retry = await store({ type: 'immobilization', subject: 'abc 123', region: 'mx-cmx', event: 'IMMOBILIZATION' }, photo);

    expect(retry!.key).toBe(first!.key);
    expect(retry!.created).toBe(false);
    expect(retry!.sha256).toBe(first!.sha256);

    const otherAction = await store({ type: 'violation', subject: 'ABC-123', region: 'MX-CMX', event: 'overstay' }, photo);
    expect(otherAction!.key).not.toBe(first!.key);
  });

  it('honours per-call size and quality limits without changing the key', async () => {
    const identity = { type: 'immobilization', subject: 'TINY-1', maxEdge: 128, quality: 40 } as const;
    const stored = await store(identity, await image());

    expect(stored!.width).toBe(128);
    expect(stored!.height).toBe(96);
    expect(stored!.key).toBe(imageKey(tenant, identity));
  });

  it('hides assets from another tenant through row-level security', async () => {
    const identity = { type: 'avatar', subject: 'private@example.com' } as const;
    const stored = await store(identity, await image());

    const other = await signup(h.app);
    const otherTenant = await lookupTenantId(other.slug);
    const seen = await h.app.db.withTenant(otherTenant, (db) =>
      db.query('select key from image_asset where key = $1', [stored!.key]));
    expect(seen.rows).toHaveLength(0);
    expect(await h.app.db.withTenant(otherTenant, (db) => imageAsset(db, otherTenant, identity))).toBeNull();
  });

  it('rejects empty, oversized, undecodable and unsupported payloads', async () => {
    const identity = { type: 'avatar', subject: 'invalid@example.com' } as const;
    await expect(store(identity, Buffer.alloc(0))).rejects.toMatchObject({ status: 400, code: 'image_invalid' });
    await expect(store(identity, Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toMatchObject({ status: 400, code: 'image_too_large' });
    await expect(store(identity, Buffer.from('not an image'))).rejects.toMatchObject({ status: 400, code: 'image_invalid' });
    await expect(store(identity, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>'))).rejects.toMatchObject({ status: 400, code: 'image_unsupported' });
  });
});
