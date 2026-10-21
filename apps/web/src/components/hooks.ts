import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, eventsUrl, get } from '../api.js';
import { useApp } from '../app-context.js';

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

/**
 * A submission-scoped Idempotency-Key for a CRUD create form. The key stays STABLE across retries of the same
 * payload, so a lost-response retry (or a double-tap) replays the original write instead of surfacing a false
 * "already exists" conflict or duplicating the side effect/audit. It is rotated only after the server gives a
 * definitive answer (a success, or a real error like a genuine duplicate), so a corrected resubmit is a fresh
 * request that cannot trip `idempotency_key_reuse`. Pair with a pending flag to block double submits.
 */
export function useSubmitKey() {
  const ref = useRef(crypto.randomUUID());
  return { key: () => ref.current, rotate: () => { ref.current = crypto.randomUUID(); } };
}

const POLL_MS = 15_000;

/**
 * Keep a screen fresh. Where the API streams (self-hosted, a container host) this uses server-sent events; on serverless
 * hosts it polls instead, so no connection is ever held open. `onEvent` is debounced so bursts cause one refetch.
 * Polling pauses while the tab is hidden and refreshes the moment it is shown again.
 */
export function useLiveEvents(onEvent: () => void) {
  const { config } = useApp();
  const polling = config.realtime === 'poll';
  const [live, setLive] = useState(false);
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>; let closed = false;
    const fire = () => { clearTimeout(timer); timer = setTimeout(() => cb.current(), 150); };

    if (polling) {
      setLive(true);
      const tick = () => { if (!document.hidden) fire(); };
      const interval = setInterval(tick, POLL_MS);
      document.addEventListener('visibilitychange', tick);
      return () => { closed = true; clearInterval(interval); document.removeEventListener('visibilitychange', tick); clearTimeout(timer); };
    }

    let es: EventSource | null = null;
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
  }, [polling]);
  return live;
}
