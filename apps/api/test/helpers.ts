import { randomBytes } from 'node:crypto';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { IdentityVerifier } from '../src/identity.js';
import type { Delivery, Message, Notifier } from '../src/notify/notifier.js';
import { buildApp, type App } from '../src/server.js';

export interface Harness { app: App; clock: { now: Date }; notifier: CaptureNotifier; close: () => Promise<void> }

/** Records every message instead of sending it. */
export class CaptureNotifier implements Notifier {
  sent: Message[] = [];
  failing = false;
  async send(m: Message): Promise<Delivery[]> {
    if (this.failing) throw new Error('provider down');
    if (!m.to.email && !m.to.phone) return [];
    this.sent.push(m);
    return [{ channel: 'console' }];
  }
  to(who: { email?: string | null; phone?: string | null }) {
    return this.sent.filter((m) => (who.email && m.to.email === who.email) || (who.phone && m.to.phone === who.phone));
  }
}

export async function harness(opts: { env?: Record<string, string>; verifier?: (cfg: ReturnType<typeof loadConfig>) => IdentityVerifier } = {}): Promise<Harness> {
  const clock = { now: new Date('2026-10-20T14:00:00Z') };
  const notifier = new CaptureNotifier();
  const cfg = loadConfig({ ...process.env, LOG_LEVEL: 'silent', JOBS_ENABLED: 'false', TRIAL_SIGNUP: 'true', ...opts.env } as NodeJS.ProcessEnv);
  const verifier = opts.verifier?.(cfg);
  const app = await buildApp({ cfg, now: () => clock.now, notifier, verifier });
  return { app, clock, notifier, close: () => app.close() };
}

/** Poll until `fn` is truthy (background notification sends finish shortly after the response). */
export async function waitFor<T>(fn: () => T | Promise<T>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function addUnit(app: App, owner: Tenant, code: string, name = `Unit ${code}`) {
  const r = await app.inject({ method: 'POST', url: '/v1/units', headers: owner.h, payload: { code, name } });
  if (r.statusCode !== 201) throw new Error(`unit failed: ${r.body}`);
}

export interface Resident extends Tenant { email: string; phone: string }

/** A resident of `unit`, signed in, with a phone number for alerts. */
export async function addResident(app: App, owner: Tenant, unit: string, phone = '+525512345678'): Promise<Resident> {
  const email = `resident-${randomBytes(3).toString('hex')}@example.com`;
  const r = await app.inject({ method: 'POST', url: '/v1/users', headers: owner.h, payload: { email, role: 'resident', unit } });
  if (r.statusCode !== 201) throw new Error(`resident failed: ${r.body}`);
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: r.json().temporaryPassword } });
  const { token } = login.json();
  const t: Resident = { slug: owner.slug, token, h: { authorization: `Bearer ${token}`, 'x-tenant': owner.slug }, email, phone };
  await app.inject({ method: 'PATCH', url: '/v1/me/profile', headers: t.h, payload: { phone, name: 'Rosa Residente' } });
  return t;
}

/** Issues Supabase-style access tokens signed with a throwaway key, and the matching verifier. */
export async function fakeSupabase() {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };
  const issuer = 'https://proj.supabase.co/auth/v1';
  const sign = (claims: { sub: string; email?: string; aud?: string; iss?: string; exp?: string; extra?: Record<string, unknown> }) =>
    new SignJWT({ ...(claims.email ? { email: claims.email } : {}), role: 'authenticated', ...claims.extra })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' }).setSubject(claims.sub).setIssuer(claims.iss ?? issuer)
      .setAudience(claims.aud ?? 'authenticated').setIssuedAt().setExpirationTime(claims.exp ?? '1h').sign(privateKey);
  const env = { SUPABASE_URL: 'https://proj.supabase.co', SUPERADMIN_EMAILS: 'root@example.com', CRON_SECRET: 'cron-secret-123' };
  const keySet = createLocalJWKSet({ keys: [jwk] });
  return { sign, env, verifier: (cfg: ReturnType<typeof loadConfig>) => new IdentityVerifier(cfg, { keySet }) };
}

export interface Tenant { slug: string; token: string; h: Record<string, string>; email?: string }

export async function signup(app: App, country = 'MX', suffix = randomBytes(3).toString('hex')): Promise<Tenant> {
  const res = await app.inject({ method: 'POST', url: '/v1/signup', payload: {
    email: `owner-${suffix}@example.com`, password: 'correct-horse-battery', organisation: `Org ${suffix}`, country, name: 'Owner',
  } });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.body}`);
  const body = res.json();
  return { slug: body.tenant.slug, token: body.token, h: { authorization: `Bearer ${body.token}`, 'x-tenant': body.tenant.slug } };
}

let n = 0;
export const idem = (t: Tenant) => ({ ...t.h, 'idempotency-key': `k-${Date.now()}-${n++}` });

export async function addUser(app: App, owner: Tenant, role: string): Promise<Tenant> {
  const email = `${role}-${randomBytes(3).toString('hex')}@example.com`;
  const r = await app.inject({ method: 'POST', url: '/v1/users', headers: owner.h, payload: { email, role } });
  const { temporaryPassword } = r.json();
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: temporaryPassword } });
  const { token } = login.json();
  return { slug: owner.slug, token, h: { authorization: `Bearer ${token}`, 'x-tenant': owner.slug }, email };
}

/** Tenant ids are invisible without a tenant context (RLS), so tests look them up as the owner. */
export async function tenantId(slug: string): Promise<string> {
  const c = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await c.connect();
  try { return (await c.query('select id from tenant where slug = $1', [slug])).rows[0].id; } finally { await c.end(); }
}
