import { supabase } from './auth.js';
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

/** The current access token: Supabase's (auto-refreshed) or OpenPark's own session token. */
export async function accessToken(): Promise<string | null> {
  if (supabase) return (await supabase.auth.getSession()).data.session?.access_token ?? null;
  return session.token;
}

export async function headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const token = await accessToken();
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(session.tenant ? { 'x-tenant': session.tenant } : {}),
    ...extra,
  };
}

export async function request<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const h = await headers(extra);
  // Fastify rejects `content-type: application/json` with an empty body, so only send the header with a body.
  if (body === undefined) delete h['content-type'];
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: { error?: { code?: string; message?: string; details?: unknown } } | null = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON: a proxy or hosting error page */ }
  if (!res.ok || (text && data === null)) {
    // Never surface a raw JSON SyntaxError; show what the server actually said.
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? (text.trim().slice(0, 120) || res.statusText), e.details);
  }
  return data as T;
}

export const get = <T,>(path: string) => request<T>('GET', path);
export const patch = <T,>(path: string, body: unknown) => request<T>('PATCH', path, body);
export const del = <T,>(path: string) => request<T>('DELETE', path);
/** Online-only idempotent POST (the server requires a key on writes). Pass your own key to make a retry safe. */
export const post = <T,>(path: string, body?: unknown, key: string = crypto.randomUUID()) => request<T>('POST', path, body, { 'idempotency-key': key });

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
    await enqueue({ method, path, body, key, tenant: session.tenant ?? '', token: '', at: new Date().toISOString() });
    return { queued: true };
  }
}

export async function eventsUrl(): Promise<string> {
  const q = new URLSearchParams({ access_token: (await accessToken()) ?? '', tenant: session.tenant ?? '' });
  return `${BASE}/v1/events?${q}`;
}

export interface PublicConfig { trialSignup: boolean; auth: 'local' | 'external' | 'both' }

/** Deployment settings needed before sign-in. If the API cannot be reached, assume the safe (closed) setting. */
export async function fetchConfig(): Promise<PublicConfig> {
  try { return await request<PublicConfig>('GET', '/v1/config'); } catch { return { trialSignup: false, auth: 'local' }; }
}
