/** IndexedDB helpers for offline storage */
const DB_NAME = 'openpark-offline-cache';
const DB_VERSION = 1;

export async function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
      const db = (event.target as IDBOpenDBRequest).result;
      
      // Snapshot store for offline boot
      const snapshotStore = db.createObjectStore('snapshot', { keyPath: 'id' });
      snapshotStore.createIndex('byUser', 'userId', { unique: false });
      
      // Remove the duplicate device store (RW-36 fix)
      // Device info is now managed by the sync engine in openpark-sync DB
    };
    
    request.onsuccess = (event: Event) => resolve((event.target as IDBOpenDBRequest).result);
    request.onerror = (event: Event) => reject((event.target as IDBOpenDBRequest).error);
  });
}

const BOOT_LAST_KEY = 'op.boot.last';

export async function saveSnapshot(userId: string, tenant: string, who: any, me: any, sites: any[]): Promise<void> {
  const db = await openDb();
  const key = `op.boot.${userId}.${tenant}`;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('snapshot', 'readwrite');
    const store = tx.objectStore('snapshot');
    store.put({
      id: key,
      userId,
      tenant,
      savedAt: new Date().toISOString(),
      who,
      me,
      sites,
    });
    
    // Store the last-used key so we can reload it offline
    try {
      localStorage.setItem(BOOT_LAST_KEY, key);
    } catch {
      // Ignore localStorage errors (private mode, quota, etc.)
    }
    
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadSnapshot(): Promise<any | null> {
  const db = await openDb();
  const key = localStorage.getItem(BOOT_LAST_KEY);
  if (!key) return null;
  
  return new Promise<any | null>((resolve, reject) => {
    const tx = db.transaction('snapshot', 'readonly');
    const store = tx.objectStore('snapshot');
    const request = store.get(key);
    
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

/** Check if a snapshot is too old (older than 7 days) */
export function isSnapshotExpired(savedAt: string): boolean {
  const saved = new Date(savedAt).getTime();
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  return (now - saved) > sevenDays;
}

/** Clear the last-used key and all snapshot entries for a specific user/tenant combination */
export async function clearSnapshot(userId?: string, tenant?: string): Promise<void> {
  // Clear the last-used key
  try {
    localStorage.removeItem(BOOT_LAST_KEY);
  } catch {
    // Ignore localStorage errors
  }

  // If userId and tenant provided, delete that specific snapshot
  if (userId !== undefined && tenant !== undefined) {
    const db = await openDb();
    const key = `op.boot.${userId}.${tenant}`;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('snapshot', 'readwrite');
      const store = tx.objectStore('snapshot');
      store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

export async function getDeviceInfo(): Promise<{ deviceId: string; clientSeq: number }> {
  // Delegated to sync engine's storage
  const {syncStore} = await import('./../sync/storage.js');
  return syncStore.getDevice();
}

export async function incrementClientSeq(): Promise<number> {
  // Delegated to sync engine's storage
  const {syncStore} = await import('./../sync/storage.js');
  const device = await syncStore.getDevice();
  await syncStore.saveDevice(device.deviceId, device.clientSeq + 1);
  return device.clientSeq + 1;
}
