import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addResident, addUnit, addUser, fakeSupabase, harness, idem, signup, tenantId, type Harness, type Tenant } from './helpers.js';

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

describe('parking and unit CRUD', () => {
  it('edits and deletes units; refuses to delete one in use', async () => {
    const h = await harness();
    try {
      const t = await signup(h.app, 'MX');
      await h.app.inject({ method: 'POST', url: '/v1/units', headers: t.h, payload: { code: 'B-1', name: 'Tower B 1', floor: 1, note: 'corner' } });
      expect((await h.app.inject({ method: 'PATCH', url: '/v1/units/B-1', headers: t.h, payload: { name: 'Tower B, flat 1', floor: 2, site: 'DEMO-01', note: null } })).statusCode).toBe(200);
      const u = (await h.app.inject({ method: 'GET', url: '/v1/units', headers: t.h })).json().find((x: { code: string }) => x.code === 'B-1');
      expect(u).toMatchObject({ name: 'Tower B, flat 1', floor: 2, site: 'DEMO-01', note: null });
      expect((await h.app.inject({ method: 'PATCH', url: '/v1/units/NOPE', headers: t.h, payload: { name: 'x' } })).json().error.code).toBe('unit_not_found');
      expect((await h.app.inject({ method: 'PATCH', url: '/v1/units/B-1', headers: t.h, payload: { site: 'NOPE' } })).json().error.code).toBe('site_not_found');
      await h.app.inject({ method: 'POST', url: '/v1/users', headers: t.h, payload: { email: `r-${Date.now()}@example.com`, roles: ['resident'], unit: 'B-1' } });
      expect((await h.app.inject({ method: 'DELETE', url: '/v1/units/B-1', headers: t.h })).json().error.code).toBe('unit_in_use');
      await h.app.inject({ method: 'POST', url: '/v1/units', headers: t.h, payload: { code: 'B-2', name: 'Empty' } });
      expect((await h.app.inject({ method: 'DELETE', url: '/v1/units/B-2', headers: t.h })).statusCode).toBe(200);
    } finally { await h.close(); }
  });

  it('creates, edits and retires sites, zones and slots', async () => {
    const h = await harness();
    try {
      const t = await signup(h.app, 'MX');
      const call = (method: string, url: string, payload?: unknown) => h.app.inject({ method: method as 'GET', url, headers: t.h, payload: payload as object });
      expect((await call('POST', '/v1/sites', { code: 'ANNEX', name: 'Annex', timezone: 'Not/AZone' })).statusCode).toBe(400);
      expect((await call('POST', '/v1/sites', { code: 'ANNEX', name: 'Annex', timezone: 'America/Mexico_City', address: 'Calle 1', aiThreshold: 0.9 })).statusCode).toBe(201);
      expect((await call('POST', '/v1/sites', { code: 'ANNEX', name: 'Again', timezone: 'UTC' })).json().error.code).toBe('site_exists');
      expect((await call('PATCH', '/v1/sites/ANNEX', { name: 'Annex building', address: null })).statusCode).toBe(200);
      let site = (await call('GET', '/v1/sites')).json().find((s: { code: string }) => s.code === 'ANNEX');
      expect(site).toMatchObject({ name: 'Annex building', address: null, timezone: 'America/Mexico_City', settings: { aiThreshold: 0.9 }, slots: 0 });

      expect((await call('POST', '/v1/sites/ANNEX/zones', { code: 'G1', name: 'Ground', level: 0 })).statusCode).toBe(201);
      expect((await call('POST', '/v1/sites/ANNEX/zones', { code: 'G1', name: 'Dup' })).json().error.code).toBe('zone_exists');
      expect((await call('PATCH', '/v1/sites/ANNEX/zones/G1', { name: 'Ground floor', level: -1, labels: { 'es-MX': 'Planta baja' } })).statusCode).toBe(200);
      expect((await call('POST', '/v1/slots?site=ANNEX', { code: 'A1', zone: 'NOPE', type: 'standard' })).json().error.code).toBe('zone_not_found');
      expect((await call('POST', '/v1/slots?site=ANNEX', { code: 'A1', zone: 'G1', type: 'bogus' })).json().error.code).toBe('slot_type_unknown');
      expect((await call('POST', '/v1/slots?site=ANNEX', { code: 'A1', zone: 'G1', type: 'standard', note: 'near lift' })).statusCode).toBe(201);
      expect((await call('POST', '/v1/slots?site=ANNEX', { code: 'A1', zone: 'G1', type: 'standard' })).json().error.code).toBe('slot_exists');
      expect((await call('DELETE', '/v1/sites/ANNEX/zones/G1')).json().error.code).toBe('zone_in_use');
      expect((await call('PATCH', '/v1/slots/A1?site=ANNEX', { status: 'out_of_service', note: 'oil leak' })).statusCode).toBe(200);
      expect((await call('GET', '/v1/slots?site=ANNEX')).json()).toEqual([expect.objectContaining({ code: 'A1', zone: 'G1', status: 'out_of_service', note: 'oil leak' })]);
      site = (await call('GET', '/v1/sites')).json().find((s: { code: string }) => s.code === 'ANNEX');
      expect(site).toMatchObject({ slots: 1, zones: [expect.objectContaining({ code: 'G1', name: 'Ground floor', level: -1, slots: 1 })] });

      expect((await call('DELETE', '/v1/slots/A1?site=ANNEX')).statusCode).toBe(200);
      expect((await call('GET', '/v1/slots?site=ANNEX')).json()).toEqual([]);
      expect((await call('POST', '/v1/slots?site=ANNEX', { code: 'A1', zone: 'G1', type: 'standard' })).statusCode).toBe(201); // a retired code comes back
      expect((await call('DELETE', '/v1/slots/A1?site=ANNEX')).statusCode).toBe(200);
      expect((await call('DELETE', '/v1/sites/ANNEX/zones/G1')).statusCode).toBe(200);
      expect((await call('DELETE', '/v1/sites/ANNEX')).statusCode).toBe(200);
      expect((await call('GET', '/v1/sites')).json().map((s: { code: string }) => s.code)).not.toContain('ANNEX');
    } finally { await h.close(); }
  });
});

describe('integrations CRUD', () => {
  it('lists, revokes and edits API keys and webhooks without ever returning secrets', async () => {
    const h = await harness();
    try {
      const t = await signup(h.app, 'US');
      const call = (method: string, url: string, payload?: unknown) => h.app.inject({ method: method as 'GET', url, headers: t.h, payload: payload as object });
      const key = (await call('POST', '/v1/api-keys', { name: 'Gate PC', role: 'attendant', site: 'DEMO-01' })).json();
      let keys = (await call('GET', '/v1/api-keys')).json();
      expect(keys).toEqual([expect.objectContaining({ name: 'Gate PC', prefix: key.prefix, role: 'attendant', site: 'DEMO-01', revoked_at: null })]);
      expect(JSON.stringify(keys)).not.toContain(key.key);
      expect((await call('DELETE', `/v1/api-keys/${keys[0].id}`)).statusCode).toBe(200);
      expect((await call('DELETE', `/v1/api-keys/${keys[0].id}`)).json().error.code).toBe('api_key_not_found');
      keys = (await call('GET', '/v1/api-keys')).json();
      expect(keys[0].revoked_at).toBeTruthy();
      expect((await h.app.inject({ method: 'GET', url: '/v1/occupancy', headers: { authorization: `Bearer ${key.key}` } })).statusCode).toBe(401); // a revoked key stops working

      const hook = (await call('POST', '/v1/webhooks', { url: 'https://example.com/hook', events: ['session.opened'] })).json();
      expect(hook.secret).toMatch(/^whsec_/);
      let hooks = (await call('GET', '/v1/webhooks')).json();
      expect(hooks).toEqual([{ id: hook.id, url: 'https://example.com/hook', events: ['session.opened'], active: true }]);
      expect(JSON.stringify(hooks)).not.toContain(hook.secret);
      expect((await call('PATCH', `/v1/webhooks/${hook.id}`, { url: 'https://example.com/v2', events: ['session.opened', 'session.closed'], active: false })).statusCode).toBe(200);
      hooks = (await call('GET', '/v1/webhooks')).json();
      expect(hooks[0]).toMatchObject({ url: 'https://example.com/v2', events: ['session.opened', 'session.closed'], active: false });
      expect((await call('DELETE', `/v1/webhooks/${hook.id}`)).statusCode).toBe(200);
      expect((await call('PATCH', `/v1/webhooks/${hook.id}`, { active: true })).json().error.code).toBe('webhook_not_found');
      expect((await call('GET', '/v1/webhooks')).json()).toEqual([]);
    } finally { await h.close(); }
  });
});

describe('review fixes', () => {
  it('refuses webhook URLs that point at internal addresses', async () => {
    const h = await harness();
    try {
      const t = await signup(h.app, 'US');
      for (const url of ['http://127.0.0.1/x', 'http://localhost:3000/x', 'http://169.254.169.254/latest', 'http://10.0.0.5/x', 'http://[::1]/x', 'ftp://example.com/x', 'http://svc.internal/x']) {
        const r = await h.app.inject({ method: 'POST', url: '/v1/webhooks', headers: t.h, payload: { url, events: ['session.opened'] } });
        expect(r.statusCode, url).toBe(400);
      }
      expect((await h.app.inject({ method: 'POST', url: '/v1/webhooks', headers: t.h, payload: { url: 'https://example.com/hook', events: ['session.opened'] } })).statusCode).toBe(201);
    } finally { await h.close(); }
  });

  it('a replace-mode units import does not silently delete a unit with a pending invitation', async () => {
    const h = await harness();
    try {
      const t = await signup(h.app, 'MX');
      await h.app.inject({ method: 'POST', url: '/v1/units', headers: t.h, payload: { code: 'KEEP', name: 'Keep' } });
      await h.app.inject({ method: 'POST', url: '/v1/units', headers: t.h, payload: { code: 'INV', name: 'Has invite' } });
      const tid = await tenantId(t.slug);
      await h.app.db.withTenant(tid, (db) => db.query("insert into membership_invite (tenant_id, email, roles, unit_id) select $1, 'future@example.com', array['resident'], id from unit where code = 'INV'", [tid]));
      const doc = { schemaVersion: 1, tenant: t.slug, units: [{ code: 'KEEP', name: 'Keep' }] };
      const pre = await h.app.inject({ method: 'POST', url: '/v1/units/import?mode=replace', headers: t.h, payload: doc });
      expect(pre.json().diff.conflicts).toEqual([expect.objectContaining({ reason: 'has_invites' })]);
      expect(pre.json().diff.removed).toEqual([]);
    } finally { await h.close(); }
  });

  it('a retired site cannot receive units, keys or passes', async () => {
    const h = await harness();
    try {
      const t = await signup(h.app, 'MX');
      await h.app.inject({ method: 'POST', url: '/v1/sites', headers: t.h, payload: { code: 'OLD', name: 'Old', timezone: 'UTC' } });
      await h.app.inject({ method: 'POST', url: '/v1/units', headers: t.h, payload: { code: 'U9', name: 'U9', site: 'OLD' } });
      await h.app.inject({ method: 'DELETE', url: '/v1/sites/OLD', headers: t.h });
      const units = (await h.app.inject({ method: 'GET', url: '/v1/units', headers: t.h })).json();
      expect(units.find((u: { code: string }) => u.code === 'U9').site).toBeNull();
      expect((await h.app.inject({ method: 'POST', url: '/v1/units', headers: t.h, payload: { code: 'U10', name: 'x', site: 'OLD' } })).json().error.code).toBe('site_not_found');
      expect((await h.app.inject({ method: 'POST', url: '/v1/api-keys', headers: t.h, payload: { name: 'k', site: 'OLD' } })).json().error.code).toBe('site_not_found');
    } finally { await h.close(); }
  });

  it('two admins cannot demote each other at the same time', async () => {
    const h = await harness();
    try {
      const a = await signup(h.app, 'MX');
      const b = await addUser(h.app, a, 'admin');
      const users = (await h.app.inject({ method: 'GET', url: '/v1/users', headers: a.h })).json().members as { id: string; email: string }[];
      const idOf = (e: string) => users.find((u) => u.email === e)!.id;
      const aId = users.find((u) => u.email !== b.email)!.id, bId = idOf(b.email!);
      const rs = await Promise.all([
        h.app.inject({ method: 'PATCH', url: `/v1/users/${bId}`, headers: a.h, payload: { roles: ['attendant'] } }),
        h.app.inject({ method: 'PATCH', url: `/v1/users/${aId}`, headers: b.h, payload: { roles: ['attendant'] } }),
      ]);
      expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1); // the other is refused (409 last admin, or 403 once its caller was demoted)
      const left = (await h.app.db.withTenant(await tenantId(a.slug), (db) => db.query("select count(*)::int as n from membership where 'admin' = any(roles)"))).rows[0].n;
      expect(left).toBe(1);
    } finally { await h.close(); }
  });
});

describe('review fixes, round 2', () => {
  it('blocks webhook targets hidden in IPv6 forms and other internal ranges', async () => {
    const { isPrivateAddress, looksPublicHttpUrl } = await import('../src/netguard.js');
    for (const a of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::7f00:1', '2002:7f00:1::', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1', '10.1.2.3', '192.0.2.5', '198.18.0.1', '100.64.0.1', '2001:db8::1'])
      expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPrivateAddress(a), a).toBe(false);
    expect(looksPublicHttpUrl('http://[::ffff:127.0.0.1]:3000/hook')).toBe(false);
    expect(looksPublicHttpUrl('http://[::ffff:169.254.169.254]/latest')).toBe(false);
    expect(looksPublicHttpUrl('https://hooks.example.com/x')).toBe(true);
  });

  it('never stores one-time passwords in idempotency records, and malformed ids are a 4xx', async () => {
    const h = await harness();
    try {
      const t = await signup(h.app, 'MX');
      await h.app.inject({ method: 'POST', url: '/v1/units', headers: t.h, payload: { code: 'P1', name: 'P1' } });
      const doc = { schemaVersion: 1, tenant: t.slug, units: [{ code: 'P1', name: 'P1', residents: [{ email: `pw-${Date.now()}@example.com` }] }] };
      const pre = (await h.app.inject({ method: 'POST', url: '/v1/units/import', headers: t.h, payload: doc })).json();
      const applied = await h.app.inject({ method: 'POST', url: `/v1/units/import/${pre.job}/apply`, headers: idem(t), payload: {} });
      expect(applied.json().applied.residents.created[0].temporaryPassword).toBeTruthy(); // shown once to the admin
      const stored = (await h.app.db.withTenant(await tenantId(t.slug), (db) => db.query('select response::text as r from idempotency_key'))).rows.map((r) => r.r).join();
      expect(stored).not.toMatch(/temporaryPassword":"[^n]/);
      for (const [method, url] of [['PATCH', '/v1/users/abc'], ['DELETE', '/v1/users/abc'], ['DELETE', '/v1/api-keys/abc'], ['PATCH', '/v1/webhooks/abc'], ['DELETE', '/v1/webhooks/abc'], ['GET', '/v1/passes/abc']] as const) {
        const r = await h.app.inject({ method, url, headers: method === 'GET' ? t.h : idem(t), payload: method === 'PATCH' ? { active: true, roles: ['admin'] } : undefined });
        expect(r.statusCode, `${method} ${url}`).toBeLessThan(500);
      }
      expect((await h.app.inject({ method: 'DELETE', url: `/v1/invites/${encodeURIComponent('50%@x.com')}`, headers: t.h })).statusCode).toBe(404);
    } finally { await h.close(); }
  });

  it('renaming a zone drops stale translated labels; unknown slot types are refused on edit', async () => {
    const h = await harness();
    try {
      const t = await signup(h.app, 'MX');
      const zone = () => h.app.inject({ method: 'GET', url: '/v1/sites', headers: t.h }).then((r) => r.json()[0].zones[0]);
      const before = await zone();
      expect(Object.keys(before.labels).length).toBeGreaterThan(0);
      await h.app.inject({ method: 'PATCH', url: `/v1/sites/DEMO-01/zones/${before.code}`, headers: t.h, payload: { name: 'Renamed' } });
      expect(await zone()).toMatchObject({ name: 'Renamed', labels: {} });
      const slot = (await h.app.inject({ method: 'GET', url: '/v1/slots?site=DEMO-01', headers: t.h })).json()[0].code;
      expect((await h.app.inject({ method: 'PATCH', url: `/v1/slots/${slot}?site=DEMO-01`, headers: t.h, payload: { type: 'x'.repeat(30) } })).json().error.code).toBe('slot_type_unknown');
    } finally { await h.close(); }
  });
});

describe('review fixes, round 3', () => {
  it('a key limited to one site cannot administer the tenant or mint keys', async () => {
    const h = await harness();
    try {
      const t = await signup(h.app, 'US');
      await h.app.inject({ method: 'POST', url: '/v1/sites', headers: t.h, payload: { code: 'S2', name: 'Second', timezone: 'UTC' } });
      expect((await h.app.inject({ method: 'POST', url: '/v1/api-keys', headers: t.h, payload: { name: 'bad', role: 'admin', site: 'DEMO-01' } })).statusCode).toBe(400);
      const sup = (await h.app.inject({ method: 'POST', url: '/v1/api-keys', headers: t.h, payload: { name: 'gate', role: 'supervisor', site: 'DEMO-01' } })).json().key;
      const k = { 'x-api-key': sup };
      expect((await h.app.inject({ method: 'PATCH', url: '/v1/sites/S2', headers: k, payload: { name: 'x' } })).statusCode).toBeGreaterThanOrEqual(403);
      expect((await h.app.inject({ method: 'DELETE', url: '/v1/sites/S2', headers: k })).statusCode).toBeGreaterThanOrEqual(403);
      expect((await h.app.inject({ method: 'POST', url: '/v1/sites', headers: k, payload: { code: 'S3', name: 'x', timezone: 'UTC' } })).statusCode).toBeGreaterThanOrEqual(403);
      expect((await h.app.inject({ method: 'POST', url: '/v1/api-keys', headers: k, payload: { name: 'mint' } })).statusCode).toBeGreaterThanOrEqual(403);
      expect((await h.app.inject({ method: 'GET', url: '/v1/users', headers: k })).statusCode).toBe(403);
      // an old admin+site key (made before this rule) is treated as a supervisor
      const tid = await tenantId(t.slug);
      const { newApiKey } = await import('../src/auth.js');
      const old = newApiKey();
      await h.app.db.withTenant(tid, async (db) => db.query("insert into api_key (tenant_id, site_id, name, prefix, key_hash, role) select $1, id, 'old', $2, $3, 'admin' from site where code = 'DEMO-01'", [tid, old.prefix, old.hash]));
      expect((await h.app.inject({ method: 'GET', url: '/v1/users', headers: { 'x-api-key': old.key } })).statusCode).toBe(403);
    } finally { await h.close(); }
  });

  it('removing a resident, or moving them or their unit, cancels the passes they have not used', async () => {
    const h = await harness();
    try {
      const t = await signup(h.app, 'MX');
      await addUnit(h.app, t, 'Q-1');
      const r = await addResident(h.app, t, 'Q-1');
      const mk = () => h.app.inject({ method: 'POST', url: '/v1/passes', headers: idem(r), payload: { guestName: 'Visita', guestPhone: '+525500000001' } });
      const first = await mk();
      expect(first.statusCode, first.body).toBe(201);
      const id = (await h.app.inject({ method: 'GET', url: '/v1/users', headers: t.h })).json().members.find((m: { email: string }) => m.email === r.email).id;
      expect((await h.app.inject({ method: 'DELETE', url: `/v1/users/${id}`, headers: t.h })).statusCode).toBe(200);
      const rows = (await h.app.db.withTenant(await tenantId(t.slug), (db) => db.query('select status from pass'))).rows;
      expect(rows).toEqual([{ status: 'cancelled' }]);
      // a unit that moves to another site takes its unused pass along
      await addUnit(h.app, t, 'Q-2');
      const r2 = await addResident(h.app, t, 'Q-2');
      expect((await h.app.inject({ method: 'POST', url: '/v1/passes', headers: idem(r2), payload: { guestName: 'Otra', guestPhone: '+525500000002' } })).statusCode).toBe(201);
      await h.app.inject({ method: 'POST', url: '/v1/sites', headers: t.h, payload: { code: 'S2', name: 'Second', timezone: 'UTC' } });
      await h.app.inject({ method: 'PATCH', url: '/v1/units/Q-2', headers: t.h, payload: { site: 'S2' } });
      const moved = (await h.app.db.withTenant(await tenantId(t.slug), (db) => db.query("select s.code from pass p join site s on s.id = p.site_id where p.status = 'active'"))).rows;
      expect(moved).toEqual([{ code: 'S2' }]);
    } finally { await h.close(); }
  });
});

describe('review fixes, round 4', () => {
  it('a key limited to one site cannot touch another site\'s sessions, passes or exports', async () => {
    const h = await harness();
    try {
      const t = await signup(h.app, 'US');
      await h.app.inject({ method: 'POST', url: '/v1/sites', headers: t.h, payload: { code: 'B', name: 'B', timezone: 'UTC' } });
      const inA = (await h.app.inject({ method: 'POST', url: '/v1/sessions', headers: idem(t), payload: { site: 'DEMO-01', plate: { display: 'ABC1234' } } })).json();
      const key = (await h.app.inject({ method: 'POST', url: '/v1/api-keys', headers: t.h, payload: { name: 'b gate', role: 'supervisor', site: 'B' } })).json().key;
      const k = (extra: object = {}) => ({ 'x-api-key': key, 'idempotency-key': `k-${Math.random()}`, ...extra });
      const id = inA.id ?? inA.session?.id;
      expect(id).toBeTruthy();
      expect((await h.app.inject({ method: 'POST', url: `/v1/sessions/${id}/void`, headers: k(), payload: { reason: 'not mine' } })).statusCode).toBe(404);
      expect((await h.app.inject({ method: 'GET', url: `/v1/sessions/${id}/events`, headers: k() })).statusCode).toBe(404);
      expect((await h.app.inject({ method: 'POST', url: `/v1/sessions/${id}/payments`, headers: k(), payload: { method: 'cash', amount: 0 } })).statusCode).toBe(404);
      expect((await h.app.inject({ method: 'GET', url: '/v1/inventory/export?site=DEMO-01', headers: k() })).statusCode).toBe(404);
      const own = (await h.app.inject({ method: 'GET', url: '/v1/inventory/export', headers: k() })).json();
      expect(own.sites.map((s: { code: string }) => s.code)).toEqual(['B']);
      expect((await h.app.inject({ method: 'GET', url: `/v1/sessions/${id}/events`, headers: t.h })).statusCode).toBe(200); // the admin still can
    } finally { await h.close(); }
  });

  it('attendants see units but not who lives in them, and cannot export residents', async () => {
    const h = await harness();
    try {
      const t = await signup(h.app, 'MX');
      await addUnit(h.app, t, 'R-1');
      const r = await addResident(h.app, t, 'R-1');
      const att = await addUser(h.app, t, 'attendant');
      const units = (await h.app.inject({ method: 'GET', url: '/v1/units', headers: att.h })).json();
      expect(units[0]).toMatchObject({ code: 'R-1', residents: [] });
      expect(JSON.stringify(units)).not.toContain(r.email);
      expect((await h.app.inject({ method: 'GET', url: '/v1/units/export', headers: att.h })).statusCode).toBe(403);
      const admin = (await h.app.inject({ method: 'GET', url: '/v1/units', headers: t.h })).json();
      expect(admin[0].residents).toEqual([expect.objectContaining({ email: r.email })]);
    } finally { await h.close(); }
  });
});
