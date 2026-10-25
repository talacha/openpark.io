import {useSyncExternalStore} from 'react';
import engine from './engine.js';
import type {SyncState} from './engine.js';

export function useSync(): SyncState {
  const state = useSyncExternalStore<SyncState>(
    (onChange) => {
      const listener = () => onChange();
      void engine.subscribe(listener);
      return () => engine.unsubscribe(listener);
    },
    () => engine.getSnapshot(),
    () => engine.getSnapshot()
  );

  return state;
}
