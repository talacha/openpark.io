import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth.js';
import { fakeSupabase, harness, type Harness } from './helpers.js';

const uniq = () => randomBytes(4).toString('hex');
const slugOf = (name: string) => `${name}-${uniq()}`;

describe('closed preview, local accounts (TRIAL_SIGNUP off)', () => {
  let h: Harness;
  beforeAll(async () => { h = await harness({ env: { TRIAL_SIGNUP: 'false' } }); });
  afterAll(async () => { await h.close(); });

  it('reports the flag, and refuses self-service signup', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/v1/config' })).json()).toEqual({ trialSignup: false, realtime: 'sse', auth: 'local' });
    const r = await h.app.inject({ method: 'POST', url: '/v1/signup', payload: { email: 'friend@example.com', password: 'correct-horse-battery', organisation: 'Friend Co', country: 'MX' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('signup_closed');
  });

  it('lets a platform admin create an organisation for a tester, who then signs in and works normally', async () => {
    const c = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
    await c.connect();
    const email = `root-${uniq()}@example.com`;
    await c.query('insert into app_user (email, name, password_hash, is_superadmin) values ($1, $2, $3, true)', [email, 'Root', await hashPassword('correct-horse-battery')]);
    await c.end();
    const login = (await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: 'correct-horse-battery' } })).json();
    const root = { authorization: `Bearer ${login.token}` };

    expect((await h.app.inject({ method: 'POST', url: '/v1/platform/tenants', payload: { organisation: 'Nope', country: 'MX', ownerEmail: 'x@example.com' } })).statusCode).toBe(401);

    const ownerEmail = `tester-${uniq()}@example.com`;
    const slug = slugOf('friends');
    const made = await h.app.inject({ method: 'POST', url: '/v1/platform/tenants', headers: root, payload: { organisation: 'Friends HOA', country: 'MX', ownerEmail, slug } });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json()).toMatchObject({ slug, ownerEmail, temporaryPassword: expect.any(String) });

    const dup = await h.app.inject({ method: 'POST', url: '/v1/platform/tenants', headers: root, payload: { organisation: 'Again', country: 'MX', ownerEmail: 'y@example.com', slug } });
    expect(dup.statusCode).toBe(409);

    // A Super Admin assigns a person to any property and to a unit of THAT property, without being a member of it.
    const ownerLogin = (await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: ownerEmail, password: made.json().temporaryPassword } })).json();
    const oh = { authorization: `Bearer ${ownerLogin.token}`, 'x-tenant': slug };
    await h.app.inject({ method: 'POST', url: '/v1/units', headers: oh, payload: { code: 'T-1', name: 'Tower 1' } });
    expect((await h.app.inject({ method: 'GET', url: `/v1/platform/tenants/${slug}/units`, headers: root })).json()).toEqual([{ code: 'T-1', name: 'Tower 1' }]);
    expect((await h.app.inject({ method: 'GET', url: `/v1/platform/tenants/${slug}/units`, headers: oh })).statusCode).toBe(403);
    const placed = await h.app.inject({ method: 'POST', url: `/v1/platform/tenants/${slug}/members`, headers: root, payload: { email: `res-${uniq()}@example.com`, roles: ['resident', 'attendant'], unit: 'T-1' } });
    expect(placed.statusCode, placed.body).toBe(201);
    expect((await h.app.inject({ method: 'POST', url: `/v1/platform/tenants/${slug}/members`, headers: root, payload: { email: `res-${uniq()}@example.com`, roles: ['resident'], unit: 'NOPE' } })).statusCode).toBe(400);
    const listed = (await h.app.inject({ method: 'GET', url: '/v1/users', headers: oh })).json().members;
    expect(listed.find((m: { unit: string }) => m.unit === 'T-1')).toMatchObject({ roles: ['resident', 'attendant'] });

    const owner = (await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: ownerEmail, password: made.json().temporaryPassword } })).json();
    const headers = { authorization: `Bearer ${owner.token}`, 'x-tenant': slug };
    const occ = (await h.app.inject({ method: 'GET', url: '/v1/occupancy', headers })).json();
    expect(occ.totals.free).toBe(52); // the demo site and the guest-pass defaults came with it
    expect((await h.app.inject({ method: 'GET', url: '/v1/pass-policy', headers })).json().policy.overstayCharge).toBe(500000);

    // The owner can bring in their own people while signup is closed.
    const staff = await h.app.inject({ method: 'POST', url: '/v1/users', headers, payload: { email: `att-${uniq()}@example.com`, roles: ['attendant'] } });
    expect(staff.statusCode).toBe(201);
    // ...but is not a platform admin.
    expect((await h.app.inject({ method: 'GET', url: '/v1/platform/tenants', headers })).statusCode).toBe(403);
  });
});

describe('closed preview, Supabase accounts (TRIAL_SIGNUP off)', () => {
  let h: Harness;
  let sb: Awaited<ReturnType<typeof fakeSupabase>>;
  beforeAll(async () => { sb = await fakeSupabase(); h = await harness({ env: { ...sb.env, TRIAL_SIGNUP: 'false' }, verifier: sb.verifier }); });
  afterAll(async () => { await h.close(); });
  const person = async (email: string, sub = `sb-${uniq()}`) => {
    const token = await sb.sign({ sub, email });
    return { email, bearer: { authorization: `Bearer ${token}` }, h: (slug: string) => ({ authorization: `Bearer ${token}`, 'x-tenant': slug }) };
  };

  it('reports auth mode, and a signed-in stranger cannot create an organisation', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/v1/config' })).json()).toEqual({ trialSignup: false, realtime: 'sse', auth: 'external' });
    const stranger = await person(`stranger-${uniq()}@example.com`);
    const r = await h.app.inject({ method: 'POST', url: '/v1/signup', headers: stranger.bearer, payload: { organisation: 'Sneaky Co', country: 'US' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('signup_closed');
    // They still have an identity, but no organisation and nothing to see.
    const m = (await h.app.inject({ method: 'GET', url: '/v1/auth/memberships', headers: stranger.bearer })).json();
    expect(m).toMatchObject({ superadmin: false, memberships: [] });
  });

  it('invites a tester as owner: the organisation appears the first time they sign in with that email', async () => {
    const root = await person('root@example.com', 'sb-root');
    const email = `tester-${uniq()}@example.com`;
    const slug = slugOf('preview');
    const made = await h.app.inject({ method: 'POST', url: '/v1/platform/tenants', headers: root.bearer, payload: { organisation: 'Preview HOA', country: 'MX', ownerEmail: email, slug } });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json()).toMatchObject({ slug, invited: true });
    expect(made.json().temporaryPassword).toBeUndefined();

    const tester = await person(email);
    const m = (await h.app.inject({ method: 'GET', url: '/v1/auth/memberships', headers: tester.bearer })).json();
    expect(m.memberships).toEqual([expect.objectContaining({ slug, roles: ['admin'] })]);
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: tester.h(slug) })).json()).toMatchObject({ roles: ['admin'], tenant: { default_locale: 'es-MX' } });
  });

  it('gives an organisation straight to someone who already has an account, and rejects non-admins', async () => {
    const root = await person('root@example.com', 'sb-root');
    const known = await person(`known-${uniq()}@example.com`);
    await h.app.inject({ method: 'GET', url: '/v1/auth/memberships', headers: known.bearer });
    const slug = slugOf('known');
    const made = await h.app.inject({ method: 'POST', url: '/v1/platform/tenants', headers: root.bearer, payload: { organisation: 'Known HOA', country: 'US', ownerEmail: known.email, slug } });
    expect(made.statusCode).toBe(201);
    expect(made.json().invited).toBeUndefined();
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: known.h(slug) })).statusCode).toBe(200);
    const r = await h.app.inject({ method: 'POST', url: '/v1/platform/tenants', headers: known.bearer, payload: { organisation: 'Nope', country: 'US', ownerEmail: 'z@example.com' } });
    expect(r.statusCode).toBe(403);
  });
});
