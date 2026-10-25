/** ALPR offline prefetch utilities */
import { readerReadiness, subscribeReaderReadiness, prefetchReader } from './loader.js';

export type ReaderState = 'missing' | 'downloading' | 'ready' | 'failed';

export async function requestStoragePersistence(): Promise<boolean> {
  if (navigator.storage?.persist) {
    try {
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }
  return false;
}

export async function checkConnection(): Promise<boolean> {
  // Check if on metered connection (e.g., mobile data)
  const connection = (navigator as any).connection;
  return !connection?.saveData;
}

export async function prefetchModelsIfOnline(): Promise<void> {
  const isOnline = checkConnection();
  if (!isOnline) {
    console.log('Not prefetching models - on metered connection or offline');
    return;
  }
  
  try {
    await prefetchReader();
    console.log('Models prefetched successfully');
  } catch (err) {
    console.warn('Model prefetch failed:', err);
  }
}

export function getReaderState(): ReaderState {
  const readiness = readerReadiness();
  switch (readiness) {
    case 'ready': return 'ready';
    case 'downloading': return 'downloading';
    default: return 'missing';
  }
}

export function subscribeReaderState(fn: (state: ReaderState) => void): () => void {
  return subscribeReaderReadiness((status) => {
    let state: ReaderState;
    switch (status) {
      case 'ready': state = 'ready'; break;
      case 'downloading': state = 'downloading'; break;
      default: state = 'missing';
    }
    fn(state);
  });
}

export function readerReadyForOffline(): boolean {
  return getReaderState() === 'ready';
}
