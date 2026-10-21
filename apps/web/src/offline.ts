/** IndexedDB queue for attendant actions taken without signal, replayed with their Idempotency-Key. */
export interface QueuedWrite { id?: number; method: string; path: string; body: unknown; key: string; tenant: string; token: string; at: string; /** Who queued it: a write is only ever replayed by the same person. */ user?: string }
export interface Conflict extends QueuedWrite { reason: string; code: string }

const DB = 'openpark-offline';
const open = () => new Promise<IDBDatabase>((resolve, reject) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
    r.result.createObjectStore('conflicts', { keyPath: 'id', autoIncrement: true });
  };
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

async function tx<T>(store: 'queue' | 'conflicts', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const req = fn(db.transaction(store, mode).objectStore(store));
    req.onsuccess = () => { resolve(req.result); db.close(); };
    req.onerror = () => { reject(req.error); db.close(); };
  });
}

export const changes = new EventTarget();
const notify = () => changes.dispatchEvent(new Event('change'));

let owner = '';
/** The signed-in person; queued writes are stamped with it and replayed only for them. */
export const setQueueOwner = (id: string) => { owner = id; };

export async function enqueue(w: QueuedWrite) { await tx('queue', 'readwrite', (s) => s.add({ user: owner, ...w })); notify(); }
/** Put a rejected write back in the queue to try again (e.g. after the cause was fixed). */
export async function retryConflict(id: number) {
  const c = (await listConflicts()).find((x) => x.id === id);
  if (!c) return;
  const { id: _id, code: _c, reason: _r, ...w } = c;
  await tx('queue', 'readwrite', (s) => s.add(w));
  await tx('conflicts', 'readwrite', (s) => s.delete(id));
  notify();
}
export const listQueue = () => tx<QueuedWrite[]>('queue', 'readonly', (s) => s.getAll());
export const listConflicts = () => tx<Conflict[]>('conflicts', 'readonly', (s) => s.getAll());
export async function pendingCount() { return (await listQueue()).length; }
export async function dismissConflict(id: number) { await tx('conflicts', 'readwrite', (s) => s.delete(id)); notify(); }

/** Errors that mean "a human has to decide", not "try again". */
const CONFLICT_CODES = new Set(['slot_unavailable', 'assigned_slot_taken', 'site_full', 'already_inside', 'no_open_session', 'not_open']);

export interface SendResult { ok: boolean; status: number; code?: string; message?: string }
export type Sender = (w: QueuedWrite) => Promise<SendResult>;

/**
 * Replay in order. Stops at the first network failure so ordering is kept. Conflicts move to the
 * supervisor queue instead of blocking everything behind them.
 */
export async function flush(send: Sender, as?: string): Promise<{ synced: number; conflicts: number }> {
  let synced = 0, conflicts = 0;
  for (const w of await listQueue()) {
    if (as !== undefined && w.user && w.user !== as) continue; // someone else's: left for them
    let r: SendResult;
    try { r = await send(w); } catch { break; }
    if (r.ok) synced++;
    else if (r.status >= 500 || r.status === 401) break; // server down, or not signed in: keep everything for later
    else {
      conflicts++;
      const { id: _id, ...rest } = w; // the conflicts store assigns its own key
      await tx('conflicts', 'readwrite', (s) => s.add({ ...rest, code: r.code ?? 'error', reason: r.message ?? `HTTP ${r.status}` }));
      if (!CONFLICT_CODES.has(r.code ?? '')) console.warn('queued write rejected', r);
    }
    await tx('queue', 'readwrite', (s) => s.delete(w.id!));
  }
  notify();
  return { synced, conflicts };
}
