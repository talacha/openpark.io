import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { enqueue, flush, listConflicts, listQueue, retryConflict, setQueueOwner, type QueuedWrite } from '../src/offline.js';

const w = (key: string, path = '/v1/sessions'): QueuedWrite => ({ method: 'POST', path, body: { plate: { display: key } }, key, tenant: 't', token: 'x', at: new Date().toISOString() });

beforeEach(async () => {
  // Drain whatever the previous test left behind.
  await flush(async () => ({ ok: true, status: 200 }));
  for (const c of await listConflicts()) { const { dismissConflict } = await import('../src/offline.js'); await dismissConflict(c.id!); }
});

describe('offline queue', () => {
  it('replays in order, each with its original Idempotency-Key', async () => {
    await enqueue(w('a')); await enqueue(w('b')); await enqueue(w('c'));
    const seen: string[] = [];
    const r = await flush(async (x) => { seen.push(x.key); return { ok: true, status: 201 }; });
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(r).toEqual({ synced: 3, conflicts: 0 });
    expect(await listQueue()).toHaveLength(0);
  });

  it('stops at the first network failure and keeps everything behind it, in order', async () => {
    await enqueue(w('a')); await enqueue(w('b')); await enqueue(w('c'));
    let n = 0;
    const r = await flush(async () => { if (n++ === 1) throw new TypeError('offline'); return { ok: true, status: 201 }; });
    expect(r.synced).toBe(1);
    expect((await listQueue()).map((x) => x.key)).toEqual(['b', 'c']);
    await flush(async () => ({ ok: true, status: 201 }));
  });

  it('keeps items on a 5xx so they retry later', async () => {
    await enqueue(w('a'));
    await flush(async () => ({ ok: false, status: 503 }));
    expect(await listQueue()).toHaveLength(1);
    await flush(async () => ({ ok: true, status: 201 }));
  });

  it('moves slot conflicts to the supervisor queue without blocking the rest', async () => {
    await enqueue(w('a')); await enqueue(w('b'));
    const r = await flush(async (x) => x.key === 'a' ? { ok: false, status: 409, code: 'slot_unavailable', message: 'Slot B1-001 is not available' } : { ok: true, status: 201 });
    expect(r).toEqual({ synced: 1, conflicts: 1 });
    expect(await listQueue()).toHaveLength(0);
    const c = await listConflicts();
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ key: 'a', code: 'slot_unavailable' });
  });
});

describe('offline queue: who may replay what', () => {
  it('keeps everything when the session has expired (401) instead of turning it into conflicts', async () => {
    await enqueue(w('a')); await enqueue(w('b'));
    const r = await flush(async () => ({ ok: false, status: 401, code: 'invalid_token' }));
    expect(r).toEqual({ synced: 0, conflicts: 0 });
    expect((await listQueue()).map((x) => x.key)).toEqual(['a', 'b']);
    expect(await listConflicts()).toHaveLength(0);
    await flush(async () => ({ ok: true, status: 201 }));
  });

  it('replays a write only for the person who queued it', async () => {
    setQueueOwner('alice');
    await enqueue(w('alices'));
    setQueueOwner('bob');
    await enqueue(w('bobs'));
    const seen: string[] = [];
    await flush(async (x) => { seen.push(x.key); return { ok: true, status: 201 }; }, 'bob');
    expect(seen).toEqual(['bobs']);
    expect((await listQueue()).map((x) => x.key)).toEqual(['alices']); // still waiting for Alice
    await flush(async () => ({ ok: true, status: 201 }), 'alice');
    expect(await listQueue()).toHaveLength(0);
    setQueueOwner('');
  });

  it('lets a rejected write be retried', async () => {
    await enqueue(w('retry-me'));
    await flush(async () => ({ ok: false, status: 409, code: 'site_full', message: 'full' }));
    const [c] = await listConflicts();
    expect(c!.code).toBe('site_full');
    await retryConflict(c!.id!);
    expect(await listConflicts()).toHaveLength(0);
    expect((await listQueue()).map((x) => x.key)).toEqual(['retry-me']);
    await flush(async () => ({ ok: true, status: 201 }));
  });
});
