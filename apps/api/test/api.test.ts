import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addResident, addUnit, addUser, harness, idem, signup, tenantId, type Harness, type Tenant } from './helpers.js';

let h: Harness;
let t: Tenant;
beforeAll(async () => { h = await harness(); t = await signup(h.app, 'MX'); });
afterAll(async () => { await h.close(); });

const checkIn = (plate: string, extra: object = {}, tenant = t) =>
  h.app.inject({ method: 'POST', url: '/v1/sessions', headers: idem(tenant), payload: { site: 'DEMO-01', plate: { display: plate }, ...extra } });

describe('signup and seed', () => {
  it('seeds the demo site with 52 slots and a country rate plan', async () => {
    const occ = (await h.app.inject({ method: 'GET', url: '/v1/occupancy', headers: t.h })).json();
    expect(occ.totals).toMatchObject({ free: 52, occupied: 0 });
    const plans = (await h.app.inject({ method: 'GET', url: '/v1/rate-plans', headers: t.h })).json();
    expect(plans[0]).toMatchObject({ name: 'Visitor hourly', version: 1, currency: 'MXN', is_default: true });
  });
  it('rejects a duplicate email', async () => {
    const r = await h.app.inject({ method: 'POST', url: '/v1/signup', payload: { email: 'dup@example.com', password: 'correct-horse-battery', organisation: 'Dup Co', country: 'MX' } });
    const r2 = await h.app.inject({ method: 'POST', url: '/v1/signup', payload: { email: 'dup@example.com', password: 'correct-horse-battery', organisation: 'Dup Two', country: 'MX' } });
    expect([r.statusCode, r2.statusCode]).toEqual([201, 409]);
  });
  it('serves an OpenAPI 3.1 document covering the documented paths', async () => {
    const doc = (await h.app.inject({ method: 'GET', url: '/openapi.json' })).json();
    expect(doc.openapi).toBe('3.1.0');
    for (const p of ['/v1/signup', '/v1/sessions', '/v1/sessions/{id}/checkout', '/v1/checkout', '/v1/slots', '/v1/slots/{code}', '/v1/rate-plans',
      '/v1/rate-plans/{id}/quote', '/v1/inventory/export', '/v1/inventory/import', '/v1/inventory/import/{job}/apply',
      '/v1/inventory/import/{job}/rollback', '/v1/alpr/read', '/v1/reports/shifts', '/v1/sessions/{id}/payments', '/v1/sessions/{id}/events']) {
      expect(doc.paths[p], p).toBeDefined();
    }
  });
});

describe('tenant isolation (RLS)', () => {
  it('hides other tenants even with an unfiltered query', async () => {
    const other = await signup(h.app, 'US');
    const mine = await h.app.db.withTenant(await tenantId(t.slug), async (db) => (await db.query('select count(*)::int as n from slot')).rows[0].n);
    expect(mine).toBe(52);
    const none = await h.app.db.raw(async (db) => (await db.query('select count(*)::int as n from slot')).rows[0].n);
    expect(none).toBe(0); // no tenant context set: RLS returns nothing
    expect(other.slug).not.toBe(t.slug);
  });
  it('refuses a token used against a tenant it does not belong to', async () => {
    const other = await signup(h.app, 'US');
    const r = await h.app.inject({ method: 'GET', url: '/v1/occupancy', headers: { authorization: `Bearer ${t.token}`, 'x-tenant': other.slug } });
    expect(r.statusCode).toBe(403);
  });
  it('blocks writes into another tenant at the database level', async () => {
    const other = await signup(h.app, 'US');
    const otherId = await tenantId(other.slug);
    const mineId = await tenantId(t.slug);
    await expect(h.app.db.withTenant(mineId, (db) => db.query("insert into account (tenant_id, name) values ($1, 'x')", [otherId]))).rejects.toThrow(/row-level security/);
  });
  it('keeps history append-only for the app role', async () => {
    const id = await tenantId(t.slug);
    await expect(h.app.db.withTenant(id, (db) => db.query("update session_event set type = 'x'"))).rejects.toThrow(/permission denied/);
    await expect(h.app.db.withTenant(id, (db) => db.query('delete from audit_event'))).rejects.toThrow(/permission denied/);
  });
});

describe('check in and check out', () => {
  it('runs the full flow and prices the stay from server timestamps', async () => {
    h.clock.now = new Date('2026-10-20T14:12:00Z');
    const inRes = await checkIn('abc-123', { vehicle: { make: 'Nissan', model: 'Versa', color: 'white' } });
    expect(inRes.statusCode).toBe(201);
    const inn = inRes.json();
    expect(inn.slot).toBe('B1-001');
    expect(inn.vehicle.plateClass).toBe('private');

    const occ = (await h.app.inject({ method: 'GET', url: '/v1/occupancy', headers: t.h })).json();
    expect(occ.totals.occupied).toBe(1);

    h.clock.now = new Date('2026-10-20T20:09:00Z'); // 357 minutes later
    const preview = (await h.app.inject({ method: 'POST', url: '/v1/checkout/match', headers: t.h, payload: { site: 'DEMO-01', plate: 'ABC 123' } })).json();
    expect(preview).toMatchObject({ matched: true, method: 'plate', fee: { minutes: 357, total: 23000 } });

    const out = await h.app.inject({ method: 'POST', url: '/v1/checkout', headers: idem(t),
      payload: { site: 'DEMO-01', plate: 'ABC-123', payment: { method: 'cash', amount: 23000 } } });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toMatchObject({ minutes: 357, fee: { total: 23000 }, slot: 'B1-001' });

    const events = (await h.app.inject({ method: 'GET', url: `/v1/sessions/${inn.session.id}/events`, headers: t.h })).json();
    expect(events.map((e: { type: string }) => e.type)).toEqual(['check_in', 'slot_assigned', 'check_out', 'payment']);
    const occ2 = (await h.app.inject({ method: 'GET', url: '/v1/occupancy', headers: t.h })).json();
    expect(occ2.totals.occupied).toBe(0);
  });

  it('replays an idempotent write and rejects key reuse with a different body', async () => {
    const headers = idem(t);
    const body = { site: 'DEMO-01', plate: { display: 'IDM-001' } };
    const a = await h.app.inject({ method: 'POST', url: '/v1/sessions', headers, payload: body });
    const b = await h.app.inject({ method: 'POST', url: '/v1/sessions', headers, payload: body });
    expect(a.statusCode).toBe(201);
    expect(b.json().session.id).toBe(a.json().session.id);
    expect(b.headers['idempotent-replayed']).toBe('true');
    const c = await h.app.inject({ method: 'POST', url: '/v1/sessions', headers, payload: { ...body, plate: { display: 'OTHER-1' } } });
    expect(c.statusCode).toBe(422);
    const noKey = await h.app.inject({ method: 'POST', url: '/v1/sessions', headers: t.h, payload: body });
    expect(noKey.statusCode).toBe(400);
  });

  it('refuses a second check-in for a plate that is already inside', async () => {
    await checkIn('DUP-777');
    const again = await checkIn('DUP 777');
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_inside');
  });

  it('offers fuzzy candidates but never auto-closes them', async () => {
    await checkIn('FZY-123');
    const out = await h.app.inject({ method: 'POST', url: '/v1/checkout', headers: idem(t), payload: { site: 'DEMO-01', plate: 'FZY-128', region: 'MX' } });
    expect(out.statusCode).toBe(404);
    expect(out.json().error.details.candidates[0]).toMatchObject({ plate: 'FZY-123' });
    const still = (await h.app.inject({ method: 'GET', url: '/v1/sessions?status=open&plate=FZY123', headers: t.h })).json();
    expect(still.total).toBe(1);
  });

  it('checks out by ticket code, with a different attendant than the one who checked in', async () => {
    const att = await addUser(h.app, t, 'attendant');
    const inn = (await checkIn('TKT-555')).json();
    const out = await h.app.inject({ method: 'POST', url: '/v1/checkout', headers: idem(att), payload: { site: 'DEMO-01', ticket: inn.session.ticketCode } });
    expect(out.statusCode).toBe(200);
    const log = (await h.app.inject({ method: 'GET', url: '/v1/sessions?plate=TKT555', headers: t.h })).json();
    expect(log.items[0].in_by).not.toBe(log.items[0].out_by);
  });

  it('keeps the rate-plan version pinned at check-in', async () => {
    h.clock.now = new Date('2026-10-21T08:00:00Z');
    const inn = (await checkIn('VER-001')).json();
    const plans = (await h.app.inject({ method: 'GET', url: '/v1/rate-plans', headers: t.h })).json();
    const rules = { ...plans[0].rules, firstPeriodFee: 99900 };
    const v2 = await h.app.inject({ method: 'POST', url: '/v1/rate-plans', headers: t.h, payload: { site: 'DEMO-01', name: 'Visitor hourly', rules } });
    expect(v2.json().version).toBe(2);
    h.clock.now = new Date('2026-10-21T08:30:00Z');
    const out = await h.app.inject({ method: 'POST', url: `/v1/sessions/${inn.session.id}/checkout`, headers: idem(t), payload: {} });
    expect(out.json().fee.total).toBe(3000); // v1, not the new 99900
    const next = (await checkIn('VER-002')).json();
    const q = await h.app.inject({ method: 'POST', url: '/v1/checkout/match', headers: t.h, payload: { site: 'DEMO-01', ticket: next.session.ticketCode } });
    expect(q.json().fee.total).toBe(0); // grace period on v2
  });

  it('enforces roles: attendants cannot override fees, supervisors can', async () => {
    const att = await addUser(h.app, t, 'attendant');
    const sup = await addUser(h.app, t, 'supervisor');
    await addUnit(h.app, t, 'A-1');
    const aud = await addResident(h.app, t, 'A-1');
    await checkIn('ROL-001');
    await checkIn('ROL-002');
    const denied = await h.app.inject({ method: 'POST', url: '/v1/checkout', headers: idem(att), payload: { site: 'DEMO-01', plate: 'ROL-001', override: { fee: 0, reason: 'waiver' } } });
    expect(denied.statusCode).toBe(403);
    const ok = await h.app.inject({ method: 'POST', url: '/v1/checkout', headers: idem(sup), payload: { site: 'DEMO-01', plate: 'ROL-001', override: { fee: 0, reason: 'waiver' } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().fee).toMatchObject({ total: 0 });
    const readOnly = await h.app.inject({ method: 'POST', url: '/v1/checkout', headers: idem(aud), payload: { site: 'DEMO-01', plate: 'ROL-002' } });
    expect(readOnly.statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: '/v1/audit', headers: t.h })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/v1/audit', headers: att.h })).statusCode).toBe(403);
  });

  it('reports the cash taken per attendant for a site-local day', async () => {
    const r = (await h.app.inject({ method: 'GET', url: '/v1/reports/shifts?site=DEMO-01&date=2026-10-20', headers: t.h })).json();
    const owner = r.attendants.find((a: { attendant: string }) => a.attendant === 'Owner');
    expect(owner.cash).toBeGreaterThanOrEqual(23000);
  });

  it('fills up: reports a full site with free counts', async () => {
    const t2 = await signup(h.app, 'US');
    await h.app.inject({ method: 'POST', url: '/v1/inventory/import?mode=replace', headers: t2.h, payload: {
      schemaVersion: 1, tenant: t2.slug, sites: [{ code: 'DEMO-01', name: 'Demo', timezone: 'UTC', zones: [{ code: 'B1', name: 'B1', slots: [{ code: 'ONE', type: 'standard' }] }] }],
    } }).then(async (r) => h.app.inject({ method: 'POST', url: `/v1/inventory/import/${r.json().job}/apply`, headers: t2.h }));
    expect((await checkIn('FULL-001', {}, t2)).statusCode).toBe(201);
    const full = await checkIn('FULL-002', {}, t2);
    expect(full.statusCode).toBe(409);
    expect(full.json().error.code).toBe('site_full');
  });
});

describe('inventory import and export', () => {
  it('round-trips: re-importing an export produces an empty diff', async () => {
    const exp = (await h.app.inject({ method: 'GET', url: '/v1/inventory/export?site=DEMO-01', headers: t.h })).json();
    expect(exp.schemaVersion).toBe(1);
    const r = (await h.app.inject({ method: 'POST', url: '/v1/inventory/import?mode=replace&dryRun=true', headers: t.h, payload: exp })).json();
    expect(r.summary).toEqual({ added: 0, changed: 0, retired: 0, conflicts: 0 });
  });

  it('blocks replace when it would remove an occupied slot, and refuses to apply a dry run', async () => {
    await checkIn('INV-001', { slot: 'B1-010' });
    const exp = (await h.app.inject({ method: 'GET', url: '/v1/inventory/export?site=DEMO-01', headers: t.h })).json();
    exp.sites[0].zones[0].slots = exp.sites[0].zones[0].slots.filter((s: { code: string }) => s.code !== 'B1-010');
    const prev = await h.app.inject({ method: 'POST', url: '/v1/inventory/import?mode=replace', headers: t.h, payload: exp });
    expect(prev.json().summary.conflicts).toBe(1);
    const apply = await h.app.inject({ method: 'POST', url: `/v1/inventory/import/${prev.json().job}/apply`, headers: t.h });
    expect(apply.statusCode).toBe(409);
    const dry = await h.app.inject({ method: 'POST', url: '/v1/inventory/import?dryRun=true', headers: t.h, payload: exp });
    expect((await h.app.inject({ method: 'POST', url: `/v1/inventory/import/${dry.json().job}/apply`, headers: t.h })).json().error.code).toBe('dry_run');
  });

  it('merges, applies in one transaction, audits, and rolls back', async () => {
    const before = (await h.app.inject({ method: 'GET', url: '/v1/occupancy', headers: t.h })).json().totals;
    const total = (x: { free: number; occupied: number; reserved: number; outOfService: number }) => x.free + x.occupied + x.reserved + x.outOfService;
    const doc = { schemaVersion: 1, tenant: t.slug, sites: [{ code: 'DEMO-01', name: 'Demo Site', timezone: 'America/Mexico_City', zones: [
      { code: 'B2', name: { en: 'Basement 2', 'es-MX': 'Sótano 2' }, level: -2, slots: [{ range: 'B2-001..B2-020', type: 'standard' }, { code: 'B2-021', type: 'ev', attributes: { chargerKw: 11 } }] }] }] };
    const prev = (await h.app.inject({ method: 'POST', url: '/v1/inventory/import?mode=merge', headers: t.h, payload: doc })).json();
    expect(prev.summary).toMatchObject({ added: 21, conflicts: 0 });
    const applied = await h.app.inject({ method: 'POST', url: `/v1/inventory/import/${prev.job}/apply`, headers: t.h });
    expect(applied.statusCode).toBe(200);
    const mid = (await h.app.inject({ method: 'GET', url: '/v1/occupancy', headers: t.h })).json().totals;
    expect(total(mid)).toBe(total(before) + 21);
    expect((await h.app.inject({ method: 'GET', url: '/v1/audit', headers: t.h })).json().some((a: { action: string }) => a.action === 'inventory.import')).toBe(true);

    const rb = await h.app.inject({ method: 'POST', url: `/v1/inventory/import/${prev.job}/rollback`, headers: t.h });
    expect(rb.statusCode).toBe(200);
    const after = (await h.app.inject({ method: 'GET', url: '/v1/occupancy', headers: t.h })).json().totals;
    expect(total(after)).toBe(total(before));
  });

  it('reports line and column for malformed JSON text and paths for schema errors', async () => {
    const bad = await h.app.inject({ method: 'POST', url: '/v1/inventory/import', headers: t.h, payload: { text: '{\n  "schemaVersion": 1,\n  "sites": [,]\n}' } });
    expect(bad.json().error).toMatchObject({ code: 'invalid_json', details: { line: 3 } });
    const schema = await h.app.inject({ method: 'POST', url: '/v1/inventory/import', headers: t.h, payload: { schemaVersion: 1, tenant: 'x', sites: [{ code: 'A', name: 'A', timezone: 'UTC', zones: [{ code: 'Z', name: 'Z', slots: [{ type: 'standard' }] }] }] } });
    expect(schema.json().error.code).toBe('schema_invalid');
    const range = await h.app.inject({ method: 'POST', url: '/v1/inventory/import', headers: t.h, payload: { schemaVersion: 1, tenant: 'x', sites: [{ code: 'A', name: 'A', timezone: 'UTC', zones: [{ code: 'Z', name: 'Z', slots: [{ range: 'A-9..A-1', type: 'standard' }] }] }] } });
    expect(range.json().error.code).toBe('range_invalid');
  });

  it('only admins may import', async () => {
    const att = await addUser(h.app, t, 'attendant');
    const r = await h.app.inject({ method: 'POST', url: '/v1/inventory/import', headers: att.h, payload: { schemaVersion: 1, tenant: 'x', sites: [] } });
    expect(r.statusCode).toBe(403);
  });
});

describe('slots, quotes and API keys', () => {
  it('lets an attendant mark a slot out of service, but not an occupied one', async () => {
    const att = await addUser(h.app, t, 'attendant');
    const ok = await h.app.inject({ method: 'PATCH', url: '/v1/slots/B1-030?site=DEMO-01', headers: att.h, payload: { status: 'out_of_service', note: 'Column repair' } });
    expect(ok.statusCode).toBe(200);
    await checkIn('SLT-001', { slot: 'B1-031' });
    const bad = await h.app.inject({ method: 'PATCH', url: '/v1/slots/B1-031?site=DEMO-01', headers: att.h, payload: { status: 'out_of_service' } });
    expect(bad.statusCode).toBe(409);
    const typeChange = await h.app.inject({ method: 'PATCH', url: '/v1/slots/B1-032?site=DEMO-01', headers: att.h, payload: { type: 'ev' } });
    expect(typeChange.statusCode).toBe(403);
  });

  it('quotes a fee for arbitrary times', async () => {
    const plan = (await h.app.inject({ method: 'GET', url: '/v1/rate-plans', headers: t.h })).json()[0];
    const q = await h.app.inject({ method: 'POST', url: `/v1/rate-plans/${plan.id}/quote`, headers: t.h, payload: { inAt: '2026-10-20T08:12:00-06:00', outAt: '2026-10-20T14:09:00-06:00' } });
    expect(q.json()).toMatchObject({ minutes: 357 });
  });

  it('authenticates an API key scoped to its tenant and rejects a revoked/unknown one', async () => {
    const k = (await h.app.inject({ method: 'POST', url: '/v1/api-keys', headers: t.h, payload: { name: 'gate-1', role: 'attendant', site: 'DEMO-01' } })).json();
    const ok = await h.app.inject({ method: 'GET', url: '/v1/occupancy', headers: { 'x-api-key': k.key } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().totals.free).toBeGreaterThan(0);
    const bad = await h.app.inject({ method: 'GET', url: '/v1/occupancy', headers: { 'x-api-key': 'op_nope' } });
    expect(bad.statusCode).toBe(401);
  });

  it('refuses ALPR reads while AI is off', async () => {
    const own = await signup(h.app, 'US');
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: own.h })).json().tenant.ai_mode).toBe('assist'); // on by default: reading runs on the device
    await h.app.inject({ method: 'PATCH', url: '/v1/tenant', headers: idem(own), payload: { aiMode: 'off' } });
    const r = await h.app.inject({ method: 'POST', url: '/v1/alpr/read', headers: own.h, payload: { site: 'DEMO-01', image: 'AAAA' } });
    expect(r.json().error.code).toBe('ai_disabled');
  });
});

describe('config', () => {
  it('treats empty env values as unset and parses booleans properly', async () => {
    const { loadConfig } = await import('../src/config.js');
    const c = loadConfig({ ALPR_URL: '', JOBS_ENABLED: 'false' } as NodeJS.ProcessEnv);
    expect(c.ALPR_URL).toBeUndefined();
    expect(c.JOBS_ENABLED).toBe(false);
    expect(loadConfig({} as NodeJS.ProcessEnv).JOBS_ENABLED).toBe(true);
    expect(() => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/JWT_SECRET/);
  });
});

describe('serverless mode (Vercel)', () => {
  it('streams SSE from a dedicated LISTEN connection and gates the cron route', async () => {
    const { loadConfig } = await import('../src/config.js');
    const { buildApp } = await import('../src/server.js');
    const cfg = loadConfig({ ...process.env, LOG_LEVEL: 'silent', SERVERLESS: 'true', TRIAL_SIGNUP: 'true', CRON_SECRET: 'cron-secret-123', DB_POOL_MAX: '2' } as NodeJS.ProcessEnv);
    const app = await buildApp({ cfg });
    try {
      const tn = await signup(app, 'US');
      const tid = await tenantId(tn.slug);
      const got: string[] = [];
      const unsub = app.hub.subscribe(tid, (type) => got.push(type));
      await new Promise((r) => setTimeout(r, 300)); // let the dedicated connection LISTEN
      await app.inject({ method: 'POST', url: '/v1/sessions', headers: idem(tn), payload: { site: 'DEMO-01', plate: { display: 'SRV-001' } } });
      await new Promise((r) => setTimeout(r, 300));
      unsub();
      expect(got).toContain('session.opened');

      expect((await app.inject({ method: 'GET', url: '/v1/cron/retention' })).statusCode).toBe(401);
      const ok = await app.inject({ method: 'GET', url: '/v1/cron/retention', headers: { authorization: 'Bearer cron-secret-123' } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ purged: 0, idempotencyKeys: 0 });
    } finally { await app.close(); }
  });
});

describe('Supabase Data API exposure', () => {
  it('gives the anon and authenticated roles no way to read data or call functions', async () => {
    const pgm = await import('pg');
    const c = new pgm.default.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
    await c.connect();
    try {
      for (const role of ['anon', 'authenticated']) {
        await c.query(`set role ${role}`);
        for (const sql of ['select * from app_user', 'select * from tenant', 'select * from session', 'select * from api_key',
          "select user_memberships('00000000-0000-0000-0000-000000000000')", "select * from resolve_api_key('x')",
          "select create_tenant('x','x','US','en','USD','UTC','{}')"]) {
          await expect(c.query(sql), `${role}: ${sql}`).rejects.toThrow(/permission denied/);
        }
        await c.query('reset role');
      }
    } finally { await c.end(); }
  });
  it('still lets the app role log in and sign up (RLS policy on app_user)', async () => {
    const t3 = await signup(h.app, 'US');
    const r = await h.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: `${t3.slug}`.length ? (await h.app.inject({ method: 'GET', url: '/v1/me', headers: t3.h })).json().user.email : '', password: 'correct-horse-battery' } });
    expect(r.statusCode).toBe(200);
  });
});

describe('AI privacy settings persist', () => {
  it('reads back the retention period and the training opt-in exactly as saved (including turning it off)', async () => {
    const me = async () => (await h.app.inject({ method: 'GET', url: '/v1/me', headers: t.h })).json().tenant;
    expect(await me()).toMatchObject({ retention_days: 30, training_export: false }); // defaults
    await h.app.inject({ method: 'PATCH', url: '/v1/tenant', headers: t.h, payload: { trainingExport: true, retentionDays: 45 } });
    expect(await me()).toMatchObject({ retention_days: 45, training_export: true });
    // An unrelated save must not reset them.
    await h.app.inject({ method: 'PATCH', url: '/v1/tenant', headers: t.h, payload: { aiMode: 'assist' } });
    expect(await me()).toMatchObject({ retention_days: 45, training_export: true, ai_mode: 'assist' });
    await h.app.inject({ method: 'PATCH', url: '/v1/tenant', headers: t.h, payload: { trainingExport: false } });
    expect(await me()).toMatchObject({ retention_days: 45, training_export: false });
  });
});
