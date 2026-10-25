import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { addResident, addUnit, addUser, harness, idem, signup, tenantId, type Harness, type Tenant } from './helpers.js';

let h: Harness;
let owner: Tenant;
let supervisor: Tenant;
let attendant: Tenant;
let admin: Tenant;
let unit = '';
let plateN = 0;
let jpeg: Buffer;

beforeAll(async () => {
  h = await harness();
  owner = await signup(h.app, 'MX');
  supervisor = await addUser(h.app, owner, 'supervisor');
  attendant = await addUser(h.app, owner, 'attendant');
  admin = owner;
  unit = `ENF-${Date.now()}`;
  await addUnit(h.app, owner, unit, 'Enforcement Unit');
  await addResident(h.app, owner, unit);
  jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 120, g: 120, b: 120 } } }).jpeg().toBuffer();
});
afterAll(async () => { await h.close(); });

const inspect = (entry: string, who = supervisor) => h.app.inject({ method: 'GET', url: `/v1/enforcement/inspect?site=DEMO-01&entry=${encodeURIComponent(entry)}`, headers: who.h });
const flag = (entry: string, action: 'fine' | 'immobilization', evidence?: object, headers = idem(supervisor)) => h.app.inject({
  method: 'POST', url: '/v1/enforcement/flags', headers, payload: { site: 'DEMO-01', entry, action, evidence },
});
async function checkIn(host = true) {
  const plate = `ENF${++plateN}`;
  const r = await h.app.inject({ method: 'POST', url: '/v1/sessions', headers: idem(owner), payload: {
    site: 'DEMO-01', plate: { display: plate }, ...(host ? { host: { unit } } : {}),
  } });
  expect(r.statusCode, r.body).toBe(201);
  return { plate, session: { ...r.json().session, slot: r.json().slot } };
}
async function setAge(sessionId: string, hours: number) {
  await h.app.db.withTenant(await tenantId(owner.slug), async (db) => {
    await db.query('update session set in_at = $2 where id = $1', [sessionId, new Date(h.clock.now.getTime() - hours * 3_600_000)]);
  });
}

describe('supervisor enforcement access', () => {
  it('rejects attendants and admins, including attempts to flag', async () => {
    for (const who of [attendant, admin]) {
      expect((await inspect('UNKNOWN', who)).statusCode).toBe(403);
      expect((await flag('UNKNOWN', 'immobilization', undefined, idem(who))).statusCode).toBe(403);
    }
  });
});

describe('vehicle inspection', () => {
  it('accepts an open stay at exactly 12 hours and shows its box', async () => {
    const { plate, session } = await checkIn();
    await setAge(session.id, 12);
    const r = await inspect(plate);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: 'valid', reasons: [], plate, expectedSlot: session.slot, action: null });
  });

  it('flags overstay to the authorizing department for exactly 500000 MXN minor units', async () => {
    const { plate, session } = await checkIn();
    await setAge(session.id, 12.01);
    const found = (await inspect(plate)).json();
    expect(found).toMatchObject({ status: 'invalid', reasons: ['overstay'], action: 'fine', unit: { code: unit }, fine: { amountMinor: 500000, currency: 'MXN' } });
    const headers = idem(supervisor);
    const first = await flag(plate, 'fine', undefined, headers);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ action: 'fine', unit: { code: unit }, fine: { amountMinor: 500000 } });
    const replay = await flag(plate, 'fine', undefined, headers);
    expect(replay.json().id).toBe(first.json().id);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const rows = await h.app.db.withTenant(await tenantId(owner.slug), async (db) =>
      (await db.query("select unit_id, amount_minor, currency from enforcement_case where id = $1 and action = 'fine'", [first.json().id])).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount_minor: 500000, currency: 'MXN' });
  });

  it('attaches optional photo evidence to an overstay fine', async () => {
    const { plate, session } = await checkIn();
    await setAge(session.id, 12.01);
    const r = await flag(plate, 'fine', { contentType: 'image/jpeg', dataBase64: jpeg.toString('base64') });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ action: 'fine', reasons: ['overstay'], unit: { code: unit } });
    expect(r.json().evidenceUrl).toMatch(/^\/v1\/files\//);
    const stored = await h.app.db.withTenant(await tenantId(owner.slug), async (db) =>
      (await db.query("select evidence_key from enforcement_case where id = $1 and action = 'fine'", [r.json().id])).rows[0]);
    expect(stored.evidence_key).toMatch(/^[0-9a-f-]+\/db\/[a-f0-9]{64}\.webp$/);
    const file = await h.app.inject({ method: 'GET', url: r.json().evidenceUrl });
    expect(file.statusCode, file.body).toBe(200);
    expect(file.headers['content-type']).toContain('image/webp');
  });

  it('detects a current box that differs from the active permit box', async () => {
    const { plate, session } = await checkIn();
    await h.app.db.withTenant(await tenantId(owner.slug), async (db) => {
      const vehicle = (await db.query('select vehicle_id from session where id = $1', [session.id])).rows[0].vehicle_id;
      const slot = (await db.query("select id from slot where code = 'B1-040'")).rows[0].id;
      await db.query("insert into permit (tenant_id, ref, vehicle_ids, slot_id, valid_from) values ($1,$2,$3,$4,'2020-01-01')", [await tenantId(owner.slug), `ENF-${plate}`, [vehicle], slot]);
    });
    const found = (await inspect(plate)).json();
    expect(found).toMatchObject({ status: 'invalid', reasons: ['wrong_slot'], expectedSlot: 'B1-040', action: 'fine' });
  });

  it('resolves a guest-pass QR with no open check-in to its host unit', async () => {
    const resident = await addResident(h.app, owner, unit);
    const created = await h.app.inject({ method: 'POST', url: '/v1/passes', headers: idem(resident), payload: { guestName: 'Guest', guestPhone: '+525511112222' } });
    expect(created.statusCode, created.body).toBe(201);
    const found = (await inspect(created.json().qr)).json();
    expect(found).toMatchObject({ status: 'invalid', reasons: ['not_checked_in'], action: 'fine', unit: { code: unit }, plate: null });
  });
});

describe('unlinked immobilization evidence', () => {
  it('requires a valid JPEG, stores it, and serves it through the signed URL', async () => {
    const found = (await inspect('UNKNOWN-PLATE')).json();
    expect(found).toMatchObject({ status: 'invalid', reasons: ['not_checked_in'], action: 'immobilization', unit: null });
    expect((await flag('UNKNOWN-PLATE', 'immobilization')).statusCode).toBe(400);
    expect((await flag('UNKNOWN-PLATE', 'fine')).statusCode).toBe(409);
    expect((await flag('UNKNOWN-PLATE', 'immobilization', { contentType: 'image/jpeg', dataBase64: 'bm90IGEganBlZw==' })).statusCode).toBe(400);

    const r = await flag('UNKNOWN-PLATE', 'immobilization', { contentType: 'image/jpeg', dataBase64: jpeg.toString('base64') });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ action: 'immobilization', unit: null });
    expect(r.json().evidenceUrl).toMatch(/^\/v1\/files\//);
    const stored = await h.app.db.withTenant(await tenantId(owner.slug), async (db) =>
      (await db.query("select evidence_key from enforcement_case where id = $1 and action = 'immobilization'", [r.json().id])).rows[0]);
    expect(stored.evidence_key).toMatch(/^[0-9a-f-]+\/db\/[a-f0-9]{64}\.webp$/);
    const file = await h.app.inject({ method: 'GET', url: r.json().evidenceUrl });
    expect(file.statusCode, file.body).toBe(200);
    expect(file.headers['content-type']).toContain('image/webp');
  });

  it('does not allow a valid vehicle to be flagged', async () => {
    const { plate } = await checkIn();
    const r = await flag(plate, 'fine');
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('not_a_violation');
  });
});

describe('attendant report completion', () => {
  it('requires fine and immobilization before checkout and appends photos without replacing them', async () => {
    const { plate, session } = await checkIn();
    await setAge(session.id, 13);
    const report = (await flag(plate, 'fine')).json();
    const reports = await h.app.inject({ method: 'GET', url: '/v1/enforcement/reports?site=DEMO-01&status=open', headers: attendant.h });
    expect(reports.statusCode, reports.body).toBe(200);
    expect(reports.json().items.find((r: { id: string }) => r.id === report.id)).toMatchObject({ requiredActions: ['fine', 'immobilization'] });

    const blocked = await h.app.inject({ method: 'POST', url: '/v1/checkout', headers: idem(attendant), payload: { site: 'DEMO-01', ticket: session.ticketCode } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('enforcement_required');

    const issued = await h.app.inject({ method: 'POST', url: `/v1/enforcement/cases/${report.id}/fine`, headers: idem(attendant) });
    expect(issued.statusCode, issued.body).toBe(200);
    expect(issued.json()).toMatchObject({ requiredActions: ['immobilization'], fine: { amountMinor: 500000 } });
    const issuedAt = issued.json().fineIssuedAt;
    const replay = await h.app.inject({ method: 'POST', url: `/v1/enforcement/cases/${report.id}/fine`, headers: idem(attendant) });
    expect(replay.json().fineIssuedAt).toBe(issuedAt);

    const firstPhoto = await h.app.inject({ method: 'POST', url: `/v1/enforcement/cases/${report.id}/evidence`, headers: idem(attendant), payload: { contentType: 'image/jpeg', dataBase64: jpeg.toString('base64'), immobilize: false } });
    expect(firstPhoto.statusCode, firstPhoto.body).toBe(201);
    expect(firstPhoto.json()).toMatchObject({ requiredActions: ['immobilization'], immobilizedAt: null });
    expect(firstPhoto.json().evidence).toHaveLength(1);

    const secondPhoto = await h.app.inject({ method: 'POST', url: `/v1/enforcement/cases/${report.id}/evidence`, headers: idem(attendant), payload: { contentType: 'image/jpeg', dataBase64: jpeg.toString('base64'), immobilize: true } });
    expect(secondPhoto.statusCode, secondPhoto.body).toBe(201);
    expect(secondPhoto.json()).toMatchObject({ requiredActions: [], status: 'complete' });
    expect(secondPhoto.json().evidence).toHaveLength(2);
    expect(secondPhoto.json().evidence[0].url).not.toBe(secondPhoto.json().evidence[1].url);
    expect(secondPhoto.json().evidence[0].url).not.toContain(secondPhoto.json().evidence[1].id);

    const checkedOut = await h.app.inject({ method: 'POST', url: '/v1/checkout', headers: idem(attendant), payload: { site: 'DEMO-01', ticket: session.ticketCode } });
    expect(checkedOut.statusCode, checkedOut.body).toBe(200);
    const open = await h.app.inject({ method: 'GET', url: '/v1/enforcement/reports?site=DEMO-01&status=open', headers: attendant.h });
    expect(open.json().items.some((r: { id: string }) => r.id === report.id)).toBe(false);
  });
});
