import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;

/** Set when the deployment uses Supabase Auth; otherwise OpenPark's own email + password accounts are used. */
export const supabase: SupabaseClient | null = url && key ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } }) : null;
export const externalAuth = supabase !== null;

/** Sign-up details collected before the confirmation email is clicked; used to create the organisation after first sign-in. */
export interface PendingOrg { organisation: string; country: string; name?: string }
const PENDING = 'op.pendingOrg';
export const savePending = (p: PendingOrg) => { try { localStorage.setItem(PENDING, JSON.stringify(p)); } catch { /* private mode */ } };
export const takePending = (): PendingOrg | null => {
  try { const v = localStorage.getItem(PENDING); localStorage.removeItem(PENDING); return v ? (JSON.parse(v) as PendingOrg) : null; } catch { return null; }
};
export const peekPending = (): PendingOrg | null => { try { return JSON.parse(localStorage.getItem(PENDING) ?? 'null') as PendingOrg | null; } catch { return null; } };
