import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, eventsUrl, get } from '../api.js';

/** Fetch on mount and whenever `deps` change. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(!!path);
  const reload = useCallback(async () => {
    if (!path) return;
    try { setData(await get<T>(path)); setError(''); } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); } finally { setLoading(false); }
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setLoading(!!path); void reload(); }, [reload, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, loading, reload };
}

/** Server-sent events for the tenant; `onEvent` is debounced so bursts cause one refetch. */
export function useLiveEvents(onEvent: () => void) {
  const [live, setLive] = useState(false);
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    let es: EventSource | null = null; let timer: ReturnType<typeof setTimeout>; let closed = false;
    const fire = () => { clearTimeout(timer); timer = setTimeout(() => cb.current(), 150); };
    const connect = async () => {
      const url = await eventsUrl(); // a fresh token on every (re)connect
      if (closed) return;
      es = new EventSource(url);
      es.onopen = () => setLive(true);
      es.onerror = () => { setLive(false); es?.close(); if (!closed) setTimeout(() => { void connect(); }, 3000); };
      for (const ev of ['session.opened', 'session.closed', 'session.voided', 'slot.changed', 'read.needs_review']) es.addEventListener(ev, fire);
    };
    void connect();
    return () => { closed = true; es?.close(); clearTimeout(timer); };
  }, []);
  return live;
}
