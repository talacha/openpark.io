import {uuidv7, compareUuidv7} from './ids.js';
import type {SyncItem, DeviceState} from './storage.js';
import {syncStore} from './storage.js';
import {getSession} from '../api.js';
import {classify} from './classify.js';
import {MicroTs, nowMicroTs, toMicroTs, parseMicroTs, formatMicroTs, compareMicroTs} from '@openpark/core';

export type SyncStatus = 'unknown' | 'offline' | 'syncing' | 'online' | 'attention';
export type SyncListener = () => void;

export interface SyncState {
  status: SyncStatus;
  pending: number;
  conflicts: number;
  failed: number;
  lastSyncedAt: MicroTs | null;
  flushNow: () => void;
}

/**
 * Sync engine - single instance per tab, created at module level.
 * Handles queue management, response classification, and cross-tab single flusher.
 */
class SyncEngine {
  private flusher?: AbortController;
  private status: SyncStatus = 'unknown';
  private pending = 0;
  private conflicts = 0;
  private failed = 0;
  private listeners = new Set<SyncListener>();
  private deviceState: DeviceState | null = null;
  private lastSyncedAt: MicroTs | null = null;
  private snapshot: SyncState = this.createSnapshot();
  private flushing = false;
  private transport: ((item: SyncItem) => Promise<{status: number; headers?: Headers; body?: unknown}>) | null = null;
  private currentSession: {tenant: string; userId: string} | null = null;
  private retryTimer: number | null = null;

  constructor() {
    void this.init();
    window.addEventListener('online', () => void this.checkConnectivity());
    window.addEventListener('offline', () => {
      this.setStatus('offline');
      this.triggerListeners();
    });
    document.addEventListener('visibilitychange', () => void this.onVisibilityChange());
  }

  private async init() {
    // Migration step: migrate old queue items to new format
    await syncStore.migrateOldQueue();
    this.deviceState = await syncStore.getDevice();
    await this.updateCounts();
    this.triggerListeners();
    void this.checkConnectivity();
  }

  /**
   * Set the transport function for sending items.
   * Allows W3 to inject the real authenticated fetch.
   */
  setTransport(transport: (item: SyncItem) => Promise<{status: number; headers?: Headers; body?: unknown}>): void {
    this.transport = transport;
  }

  /**
   * Set the current session tenant and userId.
   * flushNow() will only send items matching this session.
   */
  setSession(tenant: string, userId: string): void {
    this.currentSession = {tenant, userId};
  }

  async enqueue(method: string, path: string, body: unknown, ifMatch?: string, offline?: boolean): Promise<string> {
    if (!this.deviceState) {
      this.deviceState = await syncStore.getDevice();
    }
    const mutationId = uuidv7();
    const deviceAt = nowMicroTs();
    
    // Get current session info for item
    const session = getSession();
    const tenant = this.currentSession?.tenant ?? session.tenant ?? '';
    const userId = this.currentSession?.userId ?? '';
    
    const item: SyncItem = {
      mutationId,
      method,
      path,
      body: offline ? {...(body as object), offline: true} : body,
      deviceAt,
      clientSeq: this.deviceState.clientSeq++,
      ifMatch,
      attempts: 0,
      status: 'pending',
      tenant,
      userId,
    };
    await syncStore.savePending(item);
    // Persist the updated device state with incremented clientSeq
    await syncStore.saveDevice(this.deviceState.deviceId, this.deviceState.clientSeq);
    this.deviceState = await syncStore.getDevice();
    await this.updateCounts();
    this.triggerListeners();
    return mutationId;
  }

  async flushNow() {
    if (this.flushing) return;
    void this.runFlush();
  }

  async subscribe(listener: SyncListener): Promise<void> {
    this.listeners.add(listener);
    listener();
  }

  unsubscribe(listener: SyncListener) {
    this.listeners.delete(listener);
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  getPending(): number {
    return this.pending;
  }

  getConflicts(): number {
    return this.conflicts;
  }

  getFailed(): number {
    return this.failed;
  }

  getSnapshot(): SyncState {
    return this.snapshot;
  }

  async resume(): Promise<void> {
    // Resume after 401 auth failure
    this.setStatus('online');
    this.triggerListeners();
    void this.runFlush();
  }

  async retry(id: string): Promise<void> {
    await syncStore.updateStatus(id, 'pending', undefined, undefined);
    this.triggerListeners();
    void this.runFlush();
  }

  async discard(id: string): Promise<void> {
    await syncStore.remove(id);
    await this.updateCounts();
    this.triggerListeners();
  }

  private setStatus(status: SyncStatus) {
    this.status = status;
  }

  private async updateCounts() {
    const items = await syncStore.listPending();
    this.pending = items.filter((i) => i.status === 'pending').length;
    this.conflicts = items.filter((i) => i.status === 'conflict').length;
    this.failed = items.filter((i) => i.status === 'failed').length;
  }

  private createSnapshot(): SyncState {
    return {
      status: this.status,
      pending: this.pending,
      conflicts: this.conflicts,
      failed: this.failed,
      lastSyncedAt: this.lastSyncedAt,
      flushNow: () => void this.flushNow(),
    };
  }

  private triggerListeners() {
    // Assign snapshot BEFORE notifying listeners (RW-33 fix)
    this.snapshot = this.createSnapshot();
    for (const listener of this.listeners) {
      listener();
    }
  }

  private async onVisibilityChange() {
    if (document.visibilityState === 'visible') {
      void this.checkConnectivity();
    }
  }

  private async checkConnectivity() {
    if (!navigator.onLine) {
      this.setStatus('offline');
      this.triggerListeners();
      return;
    }

    // Only probe if we're the flush holder
    if (!this.flushing) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);
        const res = await fetch((import.meta.env.VITE_API_URL || '') + '/v1/healthz', {
          cache: 'no-store',
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          throw new Error(`healthz returned ${res.status}`);
        }

        const body = await res.json().catch(() => null);
        if (!body || typeof body !== 'object' || !('ok' in body)) {
          throw new Error('healthz did not return expected JSON');
        }

        this.setStatus(this.conflicts > 0 || this.failed > 0 ? 'attention' : 'online');
        this.lastSyncedAt = nowMicroTs();
        this.triggerListeners();
        void this.runFlush();
      } catch {
        this.setStatus('offline');
        this.triggerListeners();
      }
    }
  }

  private async runFlush() {
    if (this.flushing || !navigator.onLine) return;
    this.flushing = true;
    try {
      if (navigator.locks?.request) {
        await navigator.locks.request('op-sync-flush', { ifAvailable: true }, async (lock) => {
          if (!lock) return; // another tab is flushing
          await this.doFlush();
        });
      } else {
        await this.doFlushWithLease(); // fallback only when locks are absent
      }
    } finally {
      this.flushing = false;
    }
  }

  private async doFlushWithLease() {
    const LEASE_KEY = 'op-sync-flush-lease';
    const EXPIRY_MS = 10000; // 10 seconds

    // Try to acquire lease atomically
    const tryAcquire = (): {owner: string; acquired: boolean} => {
      const now = Date.now();
      const leaseRaw = localStorage.getItem(LEASE_KEY);
      if (leaseRaw) {
        try {
          const lease = JSON.parse(leaseRaw) as {owner: string; expires: number};
          if (now < lease.expires) {
            return {owner: lease.owner, acquired: false};
          }
        } catch {
          // Invalid JSON, treat as no lease
        }
      }
      const owner = crypto.randomUUID();
      localStorage.setItem(LEASE_KEY, JSON.stringify({owner, expires: now + EXPIRY_MS}));
      return {owner, acquired: true};
    };

    // Refresh lease while working
    const refreshLease = (owner: string, abort: AbortSignal) => {
      const interval = setInterval(() => {
        const leaseRaw = localStorage.getItem(LEASE_KEY);
        if (leaseRaw) {
          try {
            const lease = JSON.parse(leaseRaw) as {owner: string; expires: number};
            if (lease.owner === owner && lease.expires > Date.now()) {
              localStorage.setItem(LEASE_KEY, JSON.stringify({owner, expires: Date.now() + EXPIRY_MS}));
            }
          } catch {
            // Ignore
          }
        }
      }, 2000);
      abort.addEventListener('abort', () => clearInterval(interval));
    };

    try {
      const {owner, acquired} = tryAcquire();
      if (!acquired) {
        return; // Another tab has the lease
      }

      const controller = new AbortController();
      refreshLease(owner, controller.signal);

      await this.doFlush();
    } finally {
      // Release lease
      const leaseRaw = localStorage.getItem(LEASE_KEY);
      if (leaseRaw) {
        try {
          const lease = JSON.parse(leaseRaw) as {owner: string; expires: number};
          if (lease.expires < Date.now()) {
            localStorage.removeItem(LEASE_KEY);
          }
        } catch {
          // Ignore
        }
      }
    }
  }

  private async doFlush() {
    this.setStatus('syncing');
    this.triggerListeners();

    const items = await syncStore.listPending();

    // Filter to current session items only
    const itemsToSend = this.currentSession
      ? items.filter(i => (i.tenant === this.currentSession!.tenant && i.userId === this.currentSession!.userId))
      : items;

    // Sort by clientSeq for FIFO ordering
    itemsToSend.sort((a, b) => a.clientSeq - b.clientSeq);

    let syncFailed = false;
    let nextRetryAt: MicroTs | null = null;

    for (const item of itemsToSend) {
      // Skip non-pending items
      if (item.status !== 'pending') {
        continue;
      }

      // Skip items still in backoff
      if (item.nextAttemptAt) {
        const now = nowMicroTs();
        if (compareMicroTs(item.nextAttemptAt, now) > 0) {
          if (!nextRetryAt || compareMicroTs(item.nextAttemptAt, nextRetryAt) < 0) {
            nextRetryAt = item.nextAttemptAt;
          }
          continue; // Not yet time to retry - preserve FIFO order by not continuing
        }
      }

      const result = await this.sendItem(item);
      if (!result.ok) {
        const classification = classify({status: result.status, code: result.code});
        const nextAttempt = this.calculateNextAttempt(result.status, result.code, result.retryAfter);

        switch (classification) {
          case 'done':
            // Success: remove from queue
            await syncStore.remove(item.mutationId);
            break;

          case 'auth':
            // Auth required: stop and surface attention
            await syncStore.updateStatus(item.mutationId, 'pending', result.message, nextAttempt ?? undefined);
            this.setStatus('attention');
            syncFailed = true;
            break;

          case 'retry':
            // Retryable: schedule next attempt
            await syncStore.updateStatus(item.mutationId, 'pending', result.message, nextAttempt);
            // Stop at first retryable failure to preserve FIFO order (RW-05)
            if (!nextRetryAt || compareMicroTs(nextAttempt, nextRetryAt) < 0) {
              nextRetryAt = nextAttempt;
            }
            syncFailed = true;
            break;

          case 'conflict':
          case 'failed':
            // Terminal: mark as failed
            await syncStore.updateStatus(item.mutationId, 'failed', result.message);
            break;
        }

        if (syncFailed) {
          break; // Stop at first failure (retryable or auth) to preserve order
        }
      } else {
        // Success: remove from queue
        await syncStore.remove(item.mutationId);
      }
    }

    await this.updateCounts();
    if (!syncFailed && this.status === 'syncing') {
      this.setStatus(this.conflicts > 0 || this.failed > 0 ? 'attention' : 'online');
    }
    this.triggerListeners();

    // Schedule retry timer if needed
    if (nextRetryAt) {
      this.scheduleRetryTimer(nextRetryAt);
    }
  }

  private async sendItem(item: SyncItem): Promise<{ok: boolean; status: number; code?: string; message?: string; retryAfter?: number}> {
    // Use provided transport if available, otherwise use built-in
    if (this.transport) {
      const result = await this.transport(item);
      if (result.status >= 200 && result.status < 300) {
        return {ok: true, status: result.status};
      }
      const errorBody = result.body as {error?: {code?: string; message?: string}} | null;
      const error = errorBody?.error ?? {};
      const retryAfter = result.headers?.get('Retry-After');
      return {
        ok: false,
        status: result.status,
        code: error.code,
        message: error.message ?? `HTTP ${result.status}`,
        retryAfter: retryAfter ? parseInt(retryAfter, 10) : undefined,
      };
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'Idempotency-Key': item.mutationId,
      'X-Device-Id': this.deviceState?.deviceId ?? 'unknown',
      'X-Client-Seq': String(item.clientSeq),
    };

    const session = getSession();
    const token = session.token ?? null;
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }

    const currentTenant = this.currentSession?.tenant ?? session.tenant;
    if (currentTenant) {
      headers['x-tenant'] = currentTenant;
    }

    if (item.ifMatch) {
      headers['If-Match'] = item.ifMatch;
    }

    const body = {...(item.body as object), deviceAt: item.deviceAt};

    try {
      const res = await fetch((import.meta.env.VITE_API_URL || '') + item.path, {
        method: item.method,
        headers,
        body: JSON.stringify(body),
      });

      if (res.ok) {
        return {ok: true, status: res.status};
      }

      let errorBody: any = null;
      try {
        errorBody = await res.json();
      } catch {
        // Ignore non-JSON responses
      }

      const error = errorBody?.error ?? {};
      const retryAfter = res.headers.get('Retry-After');
      return {
        ok: false,
        status: res.status,
        code: error.code,
        message: error.message ?? `HTTP ${res.status}`,
        retryAfter: retryAfter ? parseInt(retryAfter, 10) : undefined,
      };
    } catch (e) {
      // Network error - treat as status 0 for classification
      return {ok: false, status: 0, message: e instanceof Error ? e.message : String(e)};
    }
  }

  private calculateNextAttempt(status: number, code?: string, retryAfter?: number): MicroTs {
    const now = nowMicroTs();

    // Honor Retry-After header if provided
    if (retryAfter && retryAfter > 0) {
      return addMicros(now, BigInt(Math.round(retryAfter * 1000)));
    }

    // Determine backoff based on status
    let baseMs = 1000; // 1 second
    let capMs = 60000; // 60 seconds

    // For 429 and 5xx, use a longer base
    if (status === 429 || (status >= 500 && status < 600)) {
      baseMs = 2000;
    }

    // Full jitter backoff: base * 2^attempts * (0.5 + random() * 0.5)
    const attemptMultiplier = Math.pow(2, Math.min(10, 0)); // 0 attempts in this context
    const backoffMs = Math.min(baseMs * attemptMultiplier, capMs);
    const jitter = Math.random() * backoffMs;
    const totalMs = backoffMs + jitter;

    return addMicros(now, BigInt(Math.round(totalMs * 1000)));
  }

  private scheduleRetryTimer(nextRetryAt: MicroTs) {
    if (this.retryTimer) {
      window.clearTimeout(this.retryTimer);
    }

    const now = nowMicroTs();
    const diffMicros = compareMicroTs(nextRetryAt, now);
    if (diffMicros > 0) {
      const diffMs = Number(diffMicros) / 1000;
      this.retryTimer = window.setTimeout(() => {
        this.retryTimer = null;
        void this.runFlush();
      }, diffMs);
    }
  }
}

// Helper functions for microsecond arithmetic
function addMicros(a: MicroTs, b: bigint): MicroTs {
  const sum = parseMicroTs(a) + b;
  return formatMicroTs(sum);
}

// Singleton instance
const engine = new SyncEngine();

export default engine;
