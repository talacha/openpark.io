import { enqueue } from './offline.js';

const BASE: string = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); }
}

export interface Session { token: string | null; tenant: string | null }
const KEY = 'op.session';
let session: Session = (() => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '') as Session; } catch { return { token: null, tenant: null }; }
})();

export const getSession = () => session;
export function setSession(s: Session) {
  session = s;
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

export function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(session.token ? { authorization: `Bearer ${session.token}` } : {}),
    ...(session.tenant ? { 'x-tenant': session.tenant } : {}),
    ...extra,
  };
}

export async function request<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const res = await fetch(BASE + path, { method, headers: headers(extra), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? res.statusText, e.details);
  }
  return data as T;
}

export const get = <T,>(path: string) => request<T>('GET', path);
export const patch = <T,>(path: string, body: unknown) => request<T>('PATCH', path, body);

/** True for fetch failures with no HTTP response, i.e. the device is offline or the server unreachable. */
export const isNetworkError = (e: unknown) => e instanceof TypeError;

export type Written<T> = { queued: false; data: T } | { queued: true };

/**
 * Idempotent write that survives losing signal: the request and its Idempotency-Key are queued in
 * IndexedDB and replayed later, so a retry can never double-apply.
 */
export async function write<T>(path: string, body: unknown, method = 'POST'): Promise<Written<T>> {
  const key = crypto.randomUUID();
  try {
    return { queued: false, data: await request<T>(method, path, body, { 'idempotency-key': key }) };
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    await enqueue({ method, path, body, key, tenant: session.tenant ?? '', token: session.token ?? '', at: new Date().toISOString() });
    return { queued: true };
  }
}

export function eventsUrl(): string {
  const q = new URLSearchParams({ access_token: session.token ?? '', tenant: session.tenant ?? '' });
  return `${BASE}/v1/events?${q}`;
}
