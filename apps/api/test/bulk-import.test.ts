import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addResident, addUnit, harness, idem, signup, tenantId, type Harness, type Tenant } from './helpers.js';

const uniq = () => randomBytes(3).toString('hex');

describe('bulk sites import/export (communities parking)', () => {
  let h: Harness;
  let t: Tenant;
  beforeAll(async () => { h = await harness(); t = await signup(h.app, 'MX'); });
  afterAll(async () => { await h.close(); });

  const imp = (body: unknown, q = '') => h.app.inject({ method: 'POST', url: `/v1/sites/import${q}`, headers: t.h, payload: body as object });
  const apply = (job: string) => h.app.inject({ method: 'POST', url: `/v1/sites/import/${job}/apply`, headers: idem(t) });
  const rollback = (job: string) => h.app.inject({ method: 'POST', url: `/v1/sites/import/${job}/rollback`, headers: idem(t) });
  const exp = async () => (await h.app.inject({ method: 'GET', url: '/v1/sites/export', headers: t.h })).json();

  it('exports the seeded demo site with no secrets, then imports a new site and applies it', async () => {
    const out = await exp();
    expect(out).toMatchObject({ schemaVersion: 1, tenant: t.slug, $schema: 'https://schemas.openpark.io/sites/v1.json' });
    expect(out.sites.find((s: { code: string }) => s.code === 'DEMO-01')).toBeTruthy();
    for (const s of out.sites) expect(Object.keys(s).every((k) => ['code', 'name', 'timezone', 'address', 'notes'].includes(k))).toBe(true);

    const code = `GATE-${uniq()}`;
    const prev = await imp({ schemaVersion: 1, sites: [{ code, name: 'North Gate', timezone: 'America/Mexico_City', address: 'Calle 1', notes: 'main entrance' }] });
    expect(prev.statusCode, prev.body).toBe(201);
    expect(prev.json().summary).toMatchObject({ added: 1, changed: 0, conflicts: 0 });

    const done = await apply(prev.json().job);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().applied).toMatchObject({ added: 1 });
    const sites = (await h.app.inject({ method: 'GET', url: '/v1/sites', headers: t.h })).json();
    expect(sites.find((s: { code: string }) => s.code === code)).toMatchObject({ name: 'North Gate', address: 'Calle 1' });
  });

  it('a dry run previews but refuses to apply; rollback restores the pre-import snapshot', async () => {
    const code = `GATE-${uniq()}`;
    const dry = await imp({ schemaVersion: 1, sites: [{ code, name: 'Temp', timezone: 'UTC' }] }, '?dryRun=true');
    expect(dry.json().summary.added).toBe(1);
    const blocked = await apply(dry.json().job);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('dry_run');

    // Apply for real, then roll back: the new site is retired again.
    const prev = await imp({ schemaVersion: 1, sites: [{ code, name: 'Temp', timezone: 'UTC' }] });
    const job = prev.json().job;
    expect((await apply(job)).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/v1/sites', headers: t.h })).json().find((s: { code: string }) => s.code === code)).toBeTruthy();
    const back = await rollback(job);
    expect(back.statusCode, back.body).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/v1/sites', headers: t.h })).json().find((s: { code: string }) => s.code === code)).toBeUndefined();
  });

  it('a replace import that would retire a site with cars inside is blocked as a conflict', async () => {
    // Open a session at DEMO-01 so it cannot be retired.
    const att = await signup(h.app, 'MX'); // separate tenant not used; keep DEMO at t
    void att;
    const res = await h.app.inject({ method: 'POST', url: '/v1/sessions', headers: idem(t), payload: { site: 'DEMO-01', plate: { display: `C${uniq()}` } } });
    expect(res.statusCode, res.body).toBe(201);
    // A replace doc that omits DEMO-01 would retire it, but a car is inside -> conflict blocks apply.
    const code = `GATE-${uniq()}`;
    const prev = await imp({ schemaVersion: 1, sites: [{ code, name: 'Only Gate', timezone: 'UTC' }] }, '?mode=replace');
    expect(prev.json().summary.conflicts).toBe(1);
    const blocked = await apply(prev.json().job);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('conflicts');
  });
});

describe('bulk users import/export (no secrets, invite path only)', () => {
  let h: Harness;
  let t: Tenant;
  beforeAll(async () => { h = await harness(); t = await signup(h.app, 'MX'); await addUnit(h.app, t, 'A-1'); });
  afterAll(async () => { await h.close(); });

  const imp = (body: unknown, q = '') => h.app.inject({ method: 'POST', url: `/v1/users/import${q}`, headers: t.h, payload: body as object });
  const apply = (job: string) => h.app.inject({ method: 'POST', url: `/v1/users/import/${job}/apply`, headers: idem(t) });
  const exp = async () => (await h.app.inject({ method: 'GET', url: '/v1/users/export', headers: t.h })).json();

  it('imports residents and staff via the invite path; the apply response carries no secret', async () => {
    const residentEmail = `res-${uniq()}@example.com`;
    const staffEmail = `att-${uniq()}@example.com`;
    const prev = await imp({ schemaVersion: 1, users: [
      { email: residentEmail, name: 'Rosa', roles: ['resident'], unit: 'A-1' },
      { email: staffEmail, roles: ['attendant'] },
    ] });
    expect(prev.statusCode, prev.body).toBe(201);
    expect(prev.json().summary).toMatchObject({ added: 2, errors: 0 });
    // The preview/diff carries no secret of any kind.
    expect(JSON.stringify(prev.json())).not.toMatch(/temporaryPassword|password/i);

    const done = await apply(prev.json().job);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().applied).toMatchObject({ added: 2, invited: 2 });
    expect(JSON.stringify(done.json())).not.toMatch(/temporaryPassword|password/i); // invite path: no plaintext OTP anywhere

    // Both rows are pending invitations (invite path), not members yet.
    const users = (await h.app.inject({ method: 'GET', url: '/v1/users', headers: t.h })).json();
    expect(users.invites.map((i: { email: string }) => i.email).sort()).toEqual([residentEmail, staffEmail].sort());
  });

  it('defaults imported residents to UNVERIFIED, and verifyUnits:true marks them verified', async () => {
    const unvouched = `res-${uniq()}@example.com`;
    const vouched = `res-${uniq()}@example.com`;
    expect((await apply((await imp({ schemaVersion: 1, users: [{ email: unvouched, roles: ['resident'], unit: 'A-1' }] })).json().job)).statusCode).toBe(200);
    expect((await apply((await imp({ schemaVersion: 1, verifyUnits: true, users: [{ email: vouched, roles: ['resident'], unit: 'A-1' }] })).json().job)).statusCode).toBe(200);
    const id = await tenantId(t.slug);
    const flag = async (email: string) => h.app.db.withTenant(id, (db) => db.query('select unit_verified from membership_invite where email = $1', [email]));
    expect((await flag(unvouched)).rows[0].unit_verified).toBe(false);
    expect((await flag(vouched)).rows[0].unit_verified).toBe(true);
  });

  it('a resident row with no existing unit is a line-level error that blocks apply', async () => {
    const prev = await imp({ schemaVersion: 1, users: [{ email: `res-${uniq()}@example.com`, roles: ['resident'], unit: 'NOPE' }] });
    expect(prev.statusCode).toBe(201);
    expect(prev.json().summary.errors).toBe(1);
    const blocked = await apply(prev.json().job);
    expect(blocked.statusCode).toBe(400);
  });

  it('export carries only email, name, roles, unit, unitVerified — never a secret', async () => {
    await addResident(h.app, t, 'A-1'); // a verified member (staff-vouched)
    const out = await exp();
    expect(out).toMatchObject({ schemaVersion: 1, tenant: t.slug, $schema: 'https://schemas.openpark.io/users/v1.json' });
    for (const u of out.users) expect(Object.keys(u).every((k) => ['email', 'name', 'roles', 'unit', 'unitVerified'].includes(k))).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/password|temporaryPassword|verify_code|secret/i);
  });
});
