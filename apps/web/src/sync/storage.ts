import {MicroTs, nowMicroTs, toMicroTs} from '@openpark/core';
import type {QueuedWrite} from '../offline.js';

export interface SyncItem {
  mutationId: string;
  method: string;
  path: string;
  body: unknown;
  deviceAt: MicroTs;
  clientSeq: number;
  ifMatch?: string;
  attempts: number;
  nextAttemptAt?: MicroTs;
  status: 'pending' | 'conflict' | 'failed';
  lastError?: string;
  tenant?: string;
  userId?: string;
}

export interface DeviceState {
  deviceId: string;
  clientSeq: number;
}

export interface SyncStore {
  getDevice(): Promise<DeviceState>;
  saveDevice(deviceId: string, clientSeq: number): Promise<void>;
  listPending(): Promise<SyncItem[]>;
  savePending(item: SyncItem): Promise<void>;
  updateStatus(id: string, status: 'pending' | 'conflict' | 'failed', lastError?: string, nextAttemptAt?: MicroTs): Promise<void>;
  remove(id: string): Promise<void>;
  migrateOldQueue(): Promise<void>;
}

// In-memory store for Node/test environments
class InMemoryStore implements SyncStore {
  private device: DeviceState | null = null;
  private items = new Map<string, SyncItem>();

  async getDevice(): Promise<DeviceState> {
    if (!this.device) {
      this.device = {deviceId: crypto.randomUUID(), clientSeq: 0};
    }
    return this.device;
  }

  async saveDevice(deviceId: string, clientSeq: number): Promise<void> {
    this.device = {deviceId, clientSeq};
  }

  async listPending(): Promise<SyncItem[]> {
    return Array.from(this.items.values());
  }

  async savePending(item: SyncItem): Promise<void> {
    this.items.set(item.mutationId, item);
  }

  async updateStatus(id: string, status: 'pending' | 'conflict' | 'failed', lastError?: string, nextAttemptAt?: MicroTs): Promise<void> {
    const item = this.items.get(id);
    if (item) {
      item.status = status;
      item.attempts += 1;
      if (lastError) item.lastError = lastError;
      if (nextAttemptAt) item.nextAttemptAt = nextAttemptAt;
      this.items.set(id, item);
    }
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }

  async migrateOldQueue(): Promise<void> {
    // In-memory: no-op, no legacy DB to migrate
  }
}

// IndexedDB store for browser environments
class IndexedDBStore implements SyncStore {
  private static readonly DB_NAME = 'openpark-sync';
  private static readonly DB_VERSION = 1;
  private static readonly DEVICE_STORE = 'device';
  private static readonly QUEUE_STORE = 'queue';

  async getDevice(): Promise<DeviceState> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IndexedDBStore.DEVICE_STORE, 'readonly');
      const req = tx.objectStore(IndexedDBStore.DEVICE_STORE).get('op-device');
      req.onsuccess = () => {
        const result = req.result as DeviceState | undefined;
        resolve(result ?? {deviceId: this.generateDeviceId(), clientSeq: 0});
      };
      req.onerror = () => reject(req.error);
    });
  }

  async saveDevice(deviceId: string, clientSeq: number): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IndexedDBStore.DEVICE_STORE, 'readwrite');
      tx.objectStore(IndexedDBStore.DEVICE_STORE).put({id: 'op-device', deviceId, clientSeq});
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async listPending(): Promise<SyncItem[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IndexedDBStore.QUEUE_STORE, 'readonly');
      const req = tx.objectStore(IndexedDBStore.QUEUE_STORE).getAll();
      req.onsuccess = () => resolve(req.result as SyncItem[]);
      req.onerror = () => reject(req.error);
    });
  }

  async savePending(item: SyncItem): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IndexedDBStore.QUEUE_STORE, 'readwrite');
      tx.objectStore(IndexedDBStore.QUEUE_STORE).put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async updateStatus(id: string, status: 'pending' | 'conflict' | 'failed', lastError?: string, nextAttemptAt?: MicroTs): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IndexedDBStore.QUEUE_STORE, 'readwrite');
      const req = tx.objectStore(IndexedDBStore.QUEUE_STORE).get(id);
      req.onsuccess = () => {
        const item = req.result as SyncItem | undefined;
        if (!item) {
          resolve();
          return;
        }
        item.status = status;
        item.attempts += 1;
        if (lastError) item.lastError = lastError;
        if (nextAttemptAt) item.nextAttemptAt = nextAttemptAt;
        tx.objectStore(IndexedDBStore.QUEUE_STORE).put(item);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async remove(id: string): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IndexedDBStore.QUEUE_STORE, 'readwrite');
      tx.objectStore(IndexedDBStore.QUEUE_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async migrateOldQueue(): Promise<void> {
    // Only proceed if indexedDB.databases() indicates the old DB exists
    if (typeof indexedDB === 'undefined') {
      return;
    }

    // Check if old DB exists using databases() if available
    if (typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases();
      const hasOldDB = dbs.some(db => db.name === 'openpark-offline');
      if (!hasOldDB) {
        return; // No legacy DB to migrate
      }
    }

    // Try to open the old DB
    const oldDb = await new Promise<IDBDatabase | null>((resolve, reject) => {
      const req = indexedDB.open('openpark-offline');
      req.onupgradeneeded = () => {
        // If this is a new DB being created, abort - we should not create it
        req.result.close();
        resolve(null);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null); // Silently skip if old DB doesn't exist
    });

    if (!oldDb) {
      return; // No legacy DB
    }

    try {
      const oldQueue = await new Promise<QueuedWrite[]>((resolve, reject) => {
        const tx = oldDb.transaction('queue', 'readonly');
        const req = tx.objectStore('queue').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      if (oldQueue.length === 0) {
        oldDb.close();
        return;
      }

      // Get current device state
      let device = await this.getDevice();
      const now = nowMicroTs();

      // Migrate items with proper clientSeq allocation in same transaction
      const tx = oldDb.transaction('queue', 'readwrite');
      for (const oldItem of oldQueue) {
        const newItem: SyncItem = {
          mutationId: oldItem.key,
          method: oldItem.method,
          path: oldItem.path,
          body: oldItem.body,
          deviceAt: toMicroTs(oldItem.at), // Convert old timestamp
          clientSeq: device.clientSeq++,
          attempts: 0,
          status: 'pending',
        };
        await this.savePending(newItem);
      }

      // Save updated device state with new clientSeq
      await this.saveDevice(device.deviceId, device.clientSeq);

      // Delete migrated items from old store in the same transaction
      for (const oldItem of oldQueue) {
        tx.objectStore('queue').delete(oldItem.key);
      }
      tx.oncomplete = () => {
        oldDb.close();
        // Clean up empty old DB
        indexedDB.deleteDatabase('openpark-offline');
      };
      tx.onerror = () => {
        oldDb.close();
        throw tx.error;
      };
    } catch {
      // Migration failed - don't break the app
      oldDb.close();
    }
  }

  private async open(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') {
      throw new Error('indexedDB is not available');
    }
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IndexedDBStore.DB_NAME, IndexedDBStore.DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IndexedDBStore.DEVICE_STORE)) {
          // Use fixed key 'op-device' - no keyPath needed, use put with explicit key
          db.createObjectStore(IndexedDBStore.DEVICE_STORE);
        }
        if (!db.objectStoreNames.contains(IndexedDBStore.QUEUE_STORE)) {
          db.createObjectStore(IndexedDBStore.QUEUE_STORE, {keyPath: 'mutationId'});
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private generateDeviceId(): string {
    return crypto.randomUUID();
  }
}

// Factory to create the appropriate store
function createSyncStore(): SyncStore {
  if (typeof indexedDB !== 'undefined') {
    return new IndexedDBStore();
  }
  return new InMemoryStore();
}

// Export a singleton store instance
export const syncStore: SyncStore = createSyncStore();
