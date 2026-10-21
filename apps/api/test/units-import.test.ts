import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addResident, addUnit, addUser, fakeSupabase, harness, idem, signup, type Harness, type Tenant } from './helpers.js';

const uniq = () => randomBytes(3).toString('hex');
const doc = (tenant: string, units: unknown[]) => ({ schemaVersion: 1, tenant, units });

describe('units JSON import/export (local accounts)', () => {
  let h: Harness;
  let t: Tenant;
  beforeAll(async () => { h = await harness(); t = await signup(h.app, 'MX'); });
  afterAll(async () => { await h.close(); });
  const imp = (body: unknown, q = '') => h.app.inject({ method: 'POST', url: `/v1/units/import${q}`, headers: t.h, payload: body as object });
  const apply = (job: string, who = t) => h.app.inject({ method: 'POST', url: `/v1/units/import/${job}/apply`, headers: idem(who) });
  const exp = async () => (await h.app.inject({ method: 'GET', url: '/v1/units/export', headers: t.h })).json();

  it('creates units and residents from a file, then exports exactly what it imported', async () => {
    const email = `rosa-${uniq()}@example.com`;
    const prev = await imp(doc(t.slug, [
      { code: 'A-101', name: 'Apartment A-101', site: 'DEMO-01', residents: [{ email, name: 'Rosa' }] },
      { code: 'A-102', name: 'Apartment A-102' },
    ]));
    expect(prev.statusCode, prev.body).toBe(201);
    expect(prev.json().summary).toMatchObject({ added: 2, residents: 1, conflicts: 0, errors: 0 });

    const done = await apply(prev.json().job);
    expect(done.statusCode, done.body).toBe(200);
    const r = done.json().applied;
    expect(r).toMatchObject({ added: 2, residents: { added: 1 } });
    expect(r.residents.created).toEqual([{ email, temporaryPassword: expect.any(String) }]); // local auth: one-time password

    // The new resident can sign in and lands in their unit.
    const login = (await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: r.residents.created[0].temporaryPassword } })).json();
    const me = (await h.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${login.token}`, 'x-tenant': t.slug } })).json();
    expect(me).toMatchObject({ roles: ['resident'], unit: { code: 'A-101' } });

    const out = await exp();
    expect(out).toMatchObject({ schemaVersion: 1, tenant: t.slug, $schema: 'https://schemas.openpark.io/units/v1.json' });
    expect(out.units).toEqual([
      { code: 'A-101', name: 'Apartment A-101', site: 'DEMO-01', residents: [{ email, name: 'Rosa' }] },
      { code: 'A-102', name: 'Apartment A-102', residents: [] },
    ]);
    // Re-importing the export is a no-op.
    const again = await imp(out, '?mode=replace&dryRun=true');
    expect(again.json().summary).toMatchObject({ added: 0, changed: 0, removed: 0, conflicts: 0, residents: 0 });
  });

  it('renames units, keeps existing residents, and never double-adds', async () => {
    await addUnit(h.app, t, 'B-1', 'Old name');
    const rez = await addResident(h.app, t, 'B-1');
    const prev = await imp(doc(t.slug, [{ code: 'B-1', name: 'New name', residents: [{ email: rez.email.toUpperCase() }, { email: `new-${uniq()}@example.com` }] }]));
    expect(prev.json().summary).toMatchObject({ added: 0, changed: 1, residents: 1 }); // the existing resident is matched case-insensitively
    expect((await apply(prev.json().job)).statusCode).toBe(200);
    expect((await exp()).units.find((u: { code: string }) => u.code === 'B-1').name).toBe('New name');
  });

  it('skips people who already hold another role instead of silently changing them', async () => {
    await addUnit(h.app, t, 'C-1');
    const att = await addUser(h.app, t, 'attendant');
    const prev = await imp(doc(t.slug, [{ code: 'C-1', name: 'C-1', residents: [{ email: att.email }] }]));
    const r = (await apply(prev.json().job)).json().applied.residents;
    expect(r.skipped).toEqual([{ email: att.email, reason: 'already attendant here' }]);
    expect(r.added).toBe(0);
  });

  it('replace mode protects units that have residents or guest passes, and removes empty ones', async () => {
    const code = `R-${uniq()}`;
    await addUnit(h.app, t, code);
    const empty = await imp(doc(t.slug, []), '?mode=replace');
    const sum = empty.json().summary;
    expect(sum.removed).toBeGreaterThanOrEqual(1);
    expect(sum.conflicts).toBeGreaterThanOrEqual(1); // units with residents from the earlier tests
    const blocked = await apply(empty.json().job);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('conflicts');

    // A file that keeps every unit with people, and drops only the empty one, applies cleanly.
    const keep = (await exp()).units.filter((u: { residents: unknown[]; code: string }) => u.residents.length || u.code !== code);
    const ok = await imp(doc(t.slug, keep), '?mode=replace');
    expect(ok.json().summary).toMatchObject({ removed: 1, conflicts: 0 });
    const res = await apply(ok.json().job);
    expect(res.json().applied.removed).toBe(1);
    expect((await exp()).units.some((u: { code: string }) => u.code === code)).toBe(false);
  });

  it('refuses to remove a unit that ever had a guest pass', async () => {
    const t2 = await signup(h.app, 'MX');
    await h.app.inject({ method: 'POST', url: '/v1/units', headers: t2.h, payload: { code: 'P-1', name: 'P-1' } });
    const rez = await addResident(h.app, t2, 'P-1');
    await h.app.inject({ method: 'POST', url: '/v1/passes', headers: idem(rez), payload: { guestName: 'Luis', guestPhone: '+525511112222' } });
    // Remove the resident (so only the pass history protects the unit), then try a replace import.
    const users = (await h.app.inject({ method: 'GET', url: '/v1/users', headers: t2.h })).json().members;
    const id = users.find((u: { email: string }) => u.email === rez.email).id;
    await h.app.inject({ method: 'DELETE' as never, url: `/v1/users/${id}`, headers: t2.h });
    const prev = await h.app.inject({ method: 'POST', url: '/v1/units/import?mode=replace', headers: t2.h, payload: doc(t2.slug, []) });
    expect(prev.json().diff.conflicts).toEqual([expect.objectContaining({ reason: 'has_passes' })]);
  });

  it('reports bad sites, schema errors and malformed JSON with their location', async () => {
    const bad = await imp(doc(t.slug, [{ code: 'Z-1', name: 'Z', site: 'NOPE' }]));
    expect(bad.json().summary.errors).toBe(1);
    const job = bad.json().job;
    const r = await apply(job);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('invalid_sites');

    const schema = await imp({ schemaVersion: 1, tenant: 'x', units: [{ name: 'no code' }] });
    expect(schema.json().error).toMatchObject({ code: 'schema_invalid', details: [{ path: 'units.0.code' }] });
    const dup = await imp(doc(t.slug, [{ code: 'D', name: '1' }, { code: 'D', name: '2' }]));
    expect(dup.json().error.details[0].message).toContain('duplicate');
    const text = await imp({ text: '{\n  "schemaVersion": 1,\n  "units": [,]\n}' });
    expect(text.json().error).toMatchObject({ code: 'invalid_json', details: { line: 3 } });
  });

  it('is admin-only, cannot apply a dry run, and does not mix with inventory jobs', async () => {
    const att = await addUser(h.app, t, 'attendant');
    expect((await h.app.inject({ method: 'POST', url: '/v1/units/import', headers: att.h, payload: doc(t.slug, []) })).statusCode).toBe(403);
    const dry = await imp(doc(t.slug, [{ code: 'DRY-1', name: 'x' }]), '?dryRun=true');
    expect((await apply(dry.json().job)).json().error.code).toBe('dry_run');
    const inv = await h.app.inject({ method: 'POST', url: '/v1/inventory/import', headers: t.h, payload: { schemaVersion: 1, tenant: t.slug, sites: [] } });
    expect((await apply(inv.json().job)).statusCode).toBe(404); // an inventory job is not a units job
    expect((await h.app.inject({ method: 'POST', url: `/v1/inventory/import/${dry.json().job}/apply`, headers: t.h })).statusCode).toBe(404);
  });
});

describe('units import with Supabase accounts', () => {
  it('invites residents by email, claimed when they first sign in', async () => {
    const sb = await fakeSupabase();
    const h = await harness({ env: sb.env, verifier: sb.verifier });
    try {
      const mk = async (email: string) => { const token = await sb.sign({ sub: `sb-${uniq()}`, email }); return { token, h: (slug: string) => ({ authorization: `Bearer ${token}`, 'x-tenant': slug }), bearer: { authorization: `Bearer ${token}` } }; };
      const owner = await mk(`owner-${uniq()}@example.com`);
      const su = await h.app.inject({ method: 'POST', url: '/v1/signup', headers: owner.bearer, payload: { organisation: `Org ${uniq()}`, country: 'MX' } });
      const slug = su.json().tenant.slug as string;
      const email = `rosa-${uniq()}@example.com`;
      const prev = await h.app.inject({ method: 'POST', url: '/v1/units/import', headers: owner.h(slug), payload: doc(slug, [{ code: 'A-1', name: 'A-1', residents: [{ email }] }]) });
      const done = await h.app.inject({ method: 'POST', url: `/v1/units/import/${prev.json().job}/apply`, headers: { ...owner.h(slug), 'idempotency-key': `k-${uniq()}` } });
      expect(done.json().applied.residents).toMatchObject({ added: 1, invited: 1, created: [] });
      const rosa = await mk(email);
      expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: rosa.h(slug) })).json()).toMatchObject({ roles: ['resident'], unit: { code: 'A-1' } });
    } finally { await h.close(); }
  });
});

describe('boolean query parameters', () => {
  it('treats dryRun=false as false (it used to be read as true)', async () => {
    const h = await harness();
    try {
      const t = await signup(h.app, 'MX');
      const post = (q: string) => h.app.inject({ method: 'POST', url: `/v1/units/import?${q}`, headers: t.h, payload: doc(t.slug, [{ code: 'Q-1', name: 'Q-1' }]) });
      expect((await post('dryRun=false')).json().dryRun).toBe(false);
      expect((await post('dryRun=true')).json().dryRun).toBe(true);
      expect((await post('dryRun=1')).json().dryRun).toBe(true);
      expect((await post('mode=merge')).json().dryRun).toBe(false);
      expect((await h.app.inject({ method: 'POST', url: '/v1/inventory/import?dryRun=false', headers: t.h, payload: { schemaVersion: 1, tenant: t.slug, sites: [] } })).json().dryRun).toBe(false);
      expect((await post('dryRun=maybe')).statusCode).toBe(400);
    } finally { await h.close(); }
  });
});
