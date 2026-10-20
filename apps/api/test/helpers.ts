import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { buildApp, type App } from '../src/server.js';
import { loadConfig } from '../src/config.js';

export interface Harness { app: App; clock: { now: Date }; close: () => Promise<void> }

export async function harness(): Promise<Harness> {
  const clock = { now: new Date('2026-10-20T14:00:00Z') };
  const cfg = loadConfig({ ...process.env, LOG_LEVEL: 'silent', JOBS_ENABLED: 'false' } as NodeJS.ProcessEnv);
  const app = await buildApp({ cfg, now: () => clock.now });
  return { app, clock, close: () => app.close() };
}

export interface Tenant { slug: string; token: string; h: Record<string, string> }

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
  return { slug: owner.slug, token, h: { authorization: `Bearer ${token}`, 'x-tenant': owner.slug } };
}

/** Tenant ids are invisible without a tenant context (RLS), so tests look them up as the owner. */
export async function tenantId(slug: string): Promise<string> {
  const c = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await c.connect();
  try { return (await c.query('select id from tenant where slug = $1', [slug])).rows[0].id; } finally { await c.end(); }
}
