import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeSupabase, harness, idem, tenantId, type Harness } from './helpers.js';

let h: Harness;
let sb: Awaited<ReturnType<typeof fakeSupabase>>;
const uniq = () => randomBytes(4).toString('hex');

beforeAll(async () => {
  sb = await fakeSupabase();
  h = await harness({ env: sb.env, verifier: sb.verifier });
});
afterAll(async () => { await h.close(); });

/** A signed-in Supabase user (token + headers for one tenant). */
async function person(email = `user-${uniq()}@example.com`, sub = `sb-${uniq()}`) {
  const token = await sb.sign({ sub, email });
  return { sub, email, token, bearer: { authorization: `Bearer ${token}` }, h: (slug?: string) => ({ authorization: `Bearer ${token}`, ...(slug ? { 'x-tenant': slug } : {}) }) };
}

async function org(country = 'MX') {
  const owner = await person();
  const res = await h.app.inject({ method: 'POST', url: '/v1/signup', headers: owner.bearer, payload: { organisation: `Org ${uniq()}`, country, name: 'Dueña' } });
  expect(res.statusCode, res.body).toBe(201);
  return { owner, slug: res.json().tenant.slug as string, headers: owner.h(res.json().tenant.slug) };
}

describe('Supabase tokens', () => {
  it('creates a tenant from a bearer token (no password) and signs the owner in just-in-time', async () => {
    const { owner, slug, headers } = await org();
    const me = (await h.app.inject({ method: 'GET', url: '/v1/me', headers })).json();
    expect(me).toMatchObject({ roles: ['admin'], user: { email: owner.email }, tenant: { slug } });
    expect(me.tenant.default_locale).toBe('es-MX');
    const policy = (await h.app.inject({ method: 'GET', url: '/v1/pass-policy', headers })).json();
    expect(policy.policy).toMatchObject({ qrTtlMin: 120, maxStayHours: 12, reminderHours: [10, 11], overstayCharge: 500000 }); // 5,000 MXN
    // The same sub always resolves to the same user.
    const again = (await h.app.inject({ method: 'GET', url: '/v1/auth/memberships', headers: owner.bearer })).json();
    expect(again.memberships).toEqual([expect.objectContaining({ slug, roles: ['admin'] })]);
  });

  it('rejects missing, forged, expired and wrong-audience tokens', async () => {
    const { slug } = await org();
    const good = await person();
    const forged = good.token.slice(0, -4) + 'AAAA';
    const expired = await sb.sign({ sub: 'x', email: 'x@example.com', exp: '-1h' });
    const wrongAud = await sb.sign({ sub: 'x', email: 'x@example.com', aud: 'something-else' });
    const wrongIss = await sb.sign({ sub: 'x', email: 'x@example.com', iss: 'https://evil.example.com/auth/v1' });
    for (const token of [forged, expired, wrongAud, wrongIss]) {
      const r = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}`, 'x-tenant': slug } });
      expect(r.statusCode).toBe(401);
    }
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: { 'x-tenant': slug } })).statusCode).toBe(401);
    // Valid token, but not a member of that tenant.
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: good.h(slug) })).statusCode).toBe(403);
  });

  it('turns local passwords off when an external provider is configured', async () => {
    expect((await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'a@example.com', password: 'whatever' } })).json().error.code).toBe('local_auth_disabled');
    const res = await h.app.inject({ method: 'POST', url: '/v1/signup', payload: { email: 'a@example.com', password: 'correct-horse-battery', organisation: 'Nope', country: 'US' } });
    expect(res.json().error.code).toBe('local_auth_disabled');
    expect((await h.app.inject({ method: 'POST', url: '/v1/signup', payload: { organisation: 'No Token', country: 'US' } })).statusCode).toBe(401);
  });

  it('refuses a second identity that claims an email already linked to another one', async () => {
    const a = await person();
    await h.app.inject({ method: 'GET', url: '/v1/auth/memberships', headers: a.bearer });
    const imposter = await person(a.email, `sb-${uniq()}`);
    const r = await h.app.inject({ method: 'GET', url: '/v1/auth/memberships', headers: imposter.bearer });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('identity_conflict');
  });
});

describe('inviting people', () => {
  it('invites by email and claims the invitation the first time that person signs in', async () => {
    const { slug, headers } = await org();
    await h.app.inject({ method: 'POST', url: '/v1/units', headers, payload: { code: 'A-1', name: 'Apartment A-1' } });
    expect((await h.app.inject({ method: 'POST', url: '/v1/users', headers: idem({ h: headers } as never), payload: { email: 'x@example.com', roles: ['resident'] } })).statusCode).toBe(400); // resident needs a unit

    const email = `rosa-${uniq()}@example.com`;
    const inv = await h.app.inject({ method: 'POST', url: '/v1/users', headers, payload: { email, roles: ['resident'], unit: 'A-1' } });
    expect(inv.statusCode).toBe(201);
    expect(inv.json()).toMatchObject({ invited: true, email });
    expect((await h.app.inject({ method: 'GET', url: '/v1/users', headers })).json().invites).toEqual([expect.objectContaining({ email, roles: ['resident'], unit: 'A-1' })]);

    // Pending invitations can be edited and withdrawn before they are claimed.
    const enc = encodeURIComponent(email);
    expect((await h.app.inject({ method: 'PATCH', url: `/v1/invites/${enc}`, headers, payload: { roles: ['attendant', 'resident'] } })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/v1/users', headers })).json().invites).toEqual([expect.objectContaining({ email, roles: ['resident', 'attendant'], unit: 'A-1' })]);
    const gone = `gone-${uniq()}@example.com`;
    await h.app.inject({ method: 'POST', url: '/v1/users', headers, payload: { email: gone, roles: ['attendant'] } });
    expect((await h.app.inject({ method: 'DELETE', url: `/v1/invites/${encodeURIComponent(gone)}`, headers })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'DELETE', url: `/v1/invites/${encodeURIComponent(gone)}`, headers })).statusCode).toBe(404);

    const rosa = await person(email);
    const m = (await h.app.inject({ method: 'GET', url: '/v1/auth/memberships', headers: rosa.bearer })).json();
    expect(m.memberships).toEqual([expect.objectContaining({ slug, roles: ['resident', 'attendant'] })]);
    const me = (await h.app.inject({ method: 'GET', url: '/v1/me', headers: rosa.h(slug) })).json();
    expect(me).toMatchObject({ roles: ['resident', 'attendant'], unit: { code: 'A-1' } });
    const users = (await h.app.inject({ method: 'GET', url: '/v1/users', headers })).json();
    expect(users.invites).toEqual([]);
    expect(users.members.find((u: { email: string }) => u.email === email)).toMatchObject({ roles: ['resident', 'attendant'], unit: 'A-1' });
  });

  it('adds someone who already has an account straight away, in a second tenant', async () => {
    const one = await org();
    const two = await org();
    await h.app.inject({ method: 'GET', url: '/v1/auth/memberships', headers: two.owner.bearer }); // known to the platform
    const r = await h.app.inject({ method: 'POST', url: '/v1/users', headers: one.headers, payload: { email: two.owner.email, roles: ['attendant'] } });
    expect(r.statusCode).toBe(201);
    const m = (await h.app.inject({ method: 'GET', url: '/v1/auth/memberships', headers: two.owner.bearer })).json().memberships;
    expect(m.map((x: { slug: string }) => x.slug).sort()).toEqual([one.slug, two.slug].sort());
    // With several tenants, the caller must say which one.
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: two.owner.bearer })).json().error.code).toBe('tenant_required');
  });

  it('keeps at least one admin, lets admins combine roles and change units, and reserves Super Admin for super admins', async () => {
    const { owner, slug, headers } = await org();
    const me = (await h.app.inject({ method: 'GET', url: '/v1/me', headers })).json();
    const self = me.user.id as string;
    const demote = await h.app.inject({ method: 'PATCH', url: `/v1/users/${self}`, headers, payload: { roles: ['attendant'] } });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe('last_admin');
    expect((await h.app.inject({ method: 'DELETE' as never, url: `/v1/users/${self}`, headers })).statusCode).toBe(409);

    await h.app.inject({ method: 'POST', url: '/v1/units', headers, payload: { code: 'B-2', name: 'B-2' } });
    const staff = await person();
    await h.app.inject({ method: 'POST', url: '/v1/users', headers, payload: { email: staff.email, roles: ['attendant'] } });
    await h.app.inject({ method: 'GET', url: '/v1/auth/memberships', headers: staff.bearer });
    const id = (await h.app.inject({ method: 'GET', url: '/v1/me', headers: staff.h(slug) })).json().user.id as string;
    expect((await h.app.inject({ method: 'PATCH', url: `/v1/users/${id}`, headers, payload: { roles: ['resident'] } })).json().error.code).toBe('unit_required');
    expect((await h.app.inject({ method: 'PATCH', url: `/v1/users/${id}`, headers, payload: { roles: ['attendant', 'resident'], unit: 'B-2' } })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: staff.h(slug) })).json()).toMatchObject({ roles: ['resident', 'attendant'], unit: { code: 'B-2' } }); // roles combine, least access first
    // Attendant + resident still cannot reach the admin APIs.
    expect((await h.app.inject({ method: 'PATCH', url: `/v1/users/${id}`, headers: staff.h(slug), payload: { superadmin: true } })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: '/v1/users', headers: staff.h(slug) })).statusCode).toBe(403);
    expect(owner.email).toBeTruthy();
  });
});

describe('platform super admin', () => {
  const root = () => person('root@example.com', 'sb-root');

  it('is granted by SUPERADMIN_EMAILS and may list every tenant; nobody else may', async () => {
    const a = await org(), b = await org();
    const su = await root();
    const m = (await h.app.inject({ method: 'GET', url: '/v1/auth/memberships', headers: su.bearer })).json();
    expect(m.superadmin).toBe(true);
    const list = (await h.app.inject({ method: 'GET', url: '/v1/platform/tenants', headers: su.bearer })).json();
    expect(list.map((t: { slug: string }) => t.slug)).toEqual(expect.arrayContaining([a.slug, b.slug]));
    expect(list.find((t: { slug: string }) => t.slug === a.slug)).toMatchObject({ members: 1, sites: 1, open_sessions: 0 });
    expect((await h.app.inject({ method: 'GET', url: '/v1/platform/tenants', headers: a.owner.bearer })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: '/v1/platform/tenants' })).statusCode).toBe(401);
  });

  it('can enter any tenant with owner powers, and every write it makes is audited in that tenant', async () => {
    const t = await org();
    const su = await root();
    expect((await h.app.inject({ method: 'GET', url: '/v1/occupancy', headers: su.h(t.slug) })).statusCode).toBe(200);
    const made = await h.app.inject({ method: 'POST', url: '/v1/units', headers: su.h(t.slug), payload: { code: 'SU-1', name: 'Created by platform' } });
    expect(made.statusCode).toBe(201);
    const audit = (await h.app.inject({ method: 'GET', url: '/v1/audit', headers: t.headers })).json();
    expect(audit.some((a: { action: string; entity: string }) => a.action === 'platform.write' && a.entity.includes('/v1/units'))).toBe(true);
    // A regular user cannot do the same to someone else's tenant.
    const other = await org();
    expect((await h.app.inject({ method: 'GET', url: '/v1/occupancy', headers: other.owner.h(t.slug) })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: '/v1/occupancy', headers: su.h('no-such-tenant') })).statusCode).toBe(404);
  });

  it('suspends and resumes a tenant: its people and API keys are locked out, the super admin is not', async () => {
    const t = await org();
    const su = await root();
    const key = (await h.app.inject({ method: 'POST', url: '/v1/api-keys', headers: t.headers, payload: { name: 'gate' } })).json().key;
    expect((await h.app.inject({ method: 'GET', url: '/v1/occupancy', headers: { 'x-api-key': key } })).statusCode).toBe(200);

    const sus = await h.app.inject({ method: 'POST', url: `/v1/platform/tenants/${t.slug}/suspend`, headers: su.bearer, payload: { reason: 'Unpaid invoice' } });
    expect(sus.statusCode).toBe(200);
    for (const headers of [t.headers, { 'x-api-key': key }]) {
      const r = await h.app.inject({ method: 'GET', url: '/v1/occupancy', headers });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe('tenant_suspended');
    }
    expect((await h.app.inject({ method: 'GET', url: '/v1/occupancy', headers: su.h(t.slug) })).statusCode).toBe(200);
    const row = (await h.app.inject({ method: 'GET', url: '/v1/platform/tenants', headers: su.bearer })).json().find((x: { slug: string }) => x.slug === t.slug);
    expect(row).toMatchObject({ suspended_reason: 'Unpaid invoice' });

    expect((await h.app.inject({ method: 'POST', url: `/v1/platform/tenants/${t.slug}/resume`, headers: su.bearer })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/v1/occupancy', headers: t.headers })).statusCode).toBe(200);
    const audit = (await h.app.inject({ method: 'GET', url: '/v1/audit', headers: t.headers })).json().map((a: { action: string }) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['platform.suspend', 'platform.resume']));
    expect((await h.app.inject({ method: 'POST', url: '/v1/platform/tenants/nope/suspend', headers: su.bearer, payload: { reason: 'xxx' } })).statusCode).toBe(404);
  });
});

describe('isolation of the new tables', () => {
  it('hides units, passes and invitations from other tenants and from the Supabase Data API roles', async () => {
    const a = await org();
    await h.app.inject({ method: 'POST', url: '/v1/units', headers: a.headers, payload: { code: 'ISO-1', name: 'Iso' } });
    await h.app.inject({ method: 'POST', url: '/v1/users', headers: a.headers, payload: { email: `inv-${uniq()}@example.com`, roles: ['attendant'] } });
    const b = await org();
    const bId = await tenantId(b.slug);
    const seen = await h.app.db.withTenant(bId, async (db) => Object.fromEntries(await Promise.all(
      ['unit', 'pass', 'pass_notification', 'membership_invite'].map(async (t) => [t, (await db.query(`select count(*)::int as n from ${t}`)).rows[0].n]))));
    expect(seen).toEqual({ unit: 0, pass: 0, pass_notification: 0, membership_invite: 0 });

    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
    await c.connect();
    try {
      for (const role of ['anon', 'authenticated']) {
        await c.query(`set role ${role}`);
        for (const sql of ['select * from unit', 'select * from pass', 'select * from membership_invite', 'select * from pass_notification', 'select * from platform_tenants()',
          'select * from due_pass_reminders(now())', "select tenant_by_slug('x')", "select claim_invites('00000000-0000-0000-0000-000000000000','x@y.z')",
          "select platform_set_suspended('x', true, 'r', null)"]) {
          await expect(c.query(sql), `${role}: ${sql}`).rejects.toThrow(/permission denied/);
        }
        await c.query('reset role');
      }
    } finally { await c.end(); }
  });
});
