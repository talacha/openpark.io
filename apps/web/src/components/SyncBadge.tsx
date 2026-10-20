import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { accessToken, isNetworkError, request } from '../api.js';
import { useApp } from '../app-context.js';
import { useT } from '../i18n.js';
import { changes, flush, listConflicts, pendingCount, type QueuedWrite, type SendResult } from '../offline.js';

const BASE: string = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

async function send(w: QueuedWrite): Promise<SendResult> {
  // Tokens expire (Supabase: hourly), so replay with the current one rather than the one stored at queue time.
  const token = (await accessToken()) ?? w.token;
  const res = await fetch(BASE + w.path, {
    method: w.method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-tenant': w.tenant, 'idempotency-key': w.key },
    body: JSON.stringify(w.body),
  });
  if (res.ok) return { ok: true, status: res.status };
  const e = (await res.json().catch(() => ({})))?.error ?? {};
  return { ok: false, status: res.status, code: e.code, message: e.message };
}

/** Shows connectivity, replays the offline queue when signal returns, and links to the supervisor queue. */
export function SyncBadge() {
  const t = useT();
  const { me } = useApp();
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(0);
  const [conflicts, setConflicts] = useState(0);
  const [note, setNote] = useState('');

  useEffect(() => {
    const refresh = async () => { setPending(await pendingCount()); setConflicts((await listConflicts()).length); };
    const sync = async () => {
      try {
        await request('GET', '/healthz');
        const r = await flush(send);
        if (r.synced) setNote(t('att.synced', { count: r.synced }));
      } catch (e) { if (!isNetworkError(e)) console.warn(e); }
      void refresh();
    };
    const up = () => { setOnline(true); void sync(); };
    const down = () => setOnline(false);
    addEventListener('online', up); addEventListener('offline', down); changes.addEventListener('change', refresh);
    void refresh(); if (navigator.onLine) void sync();
    const timer = setInterval(() => { if (navigator.onLine) void sync(); }, 30_000);
    return () => { removeEventListener('online', up); removeEventListener('offline', down); changes.removeEventListener('change', refresh); clearInterval(timer); };
  }, [t]);

  if (online && !pending && !conflicts && !note) return null;
  return (
    <Link to={`/t/${me?.tenant.slug}/queue`} className={`pill ${!online ? 'warn' : conflicts ? 'bad' : 'info'}`} style={{ textDecoration: 'none' }}>
      {!online ? t('att.offline') : conflicts ? `${conflicts} ⚠` : pending ? `${pending} ↻` : note}
    </Link>
  );
}
