import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processPassReminders } from '../src/services/passes.js';
import { addResident, addUnit, addUser, harness, idem, signup, tenantId, waitFor, type Harness, type Resident, type Tenant } from './helpers.js';

let h: Harness;
let owner: Tenant;
let supervisor: Tenant;
let attendant: Tenant;
const T0 = new Date('2026-10-20T14:00:00Z');
const at = (hours: number) => new Date(T0.getTime() + hours * 3_600_000);
const guest = { guestName: 'Luis Invitado', guestPhone: '+525511112222', guestEmail: 'luis@example.com' };

beforeAll(async () => {
  h = await harness();
  owner = await signup(h.app, 'MX');
  supervisor = await addUser(h.app, owner, 'supervisor');
  attendant = await addUser(h.app, owner, 'attendant');
});
afterAll(async () => { await h.close(); });

/** A fresh unit with its own resident, so scenarios do not share the one-active-pass-per-unit slot. */
async function resident(): Promise<Resident> {
  const code = `U-${randomBytes(3).toString('hex')}`;
  await addUnit(h.app, owner, code);
  return addResident(h.app, owner, code);
}
const create = (r: Tenant, extra: object = {}) => h.app.inject({ method: 'POST', url: '/v1/passes', headers: idem(r), payload: { ...guest, ...extra } });
const redeem = (token: string, plate: string, who = attendant) =>
  h.app.inject({ method: 'POST', url: '/v1/passes/redeem', headers: idem(who), payload: { token, site: 'DEMO-01', plate: { display: plate } } });
const checkout = (plate: string, who = attendant) => h.app.inject({ method: 'POST', url: '/v1/checkout', headers: idem(who), payload: { site: 'DEMO-01', plate } });
const plateOf = () => `P${randomBytes(3).toString('hex').toUpperCase()}`;
const runCron = (t: Tenant = owner) => tenantId(t.slug).then((id) => processPassReminders(h.app, { tenantId: id }));
const notifications = async (passId: string, t: Tenant = owner) => h.app.db.withTenant(await tenantId(t.slug), async (db) =>
  Object.fromEntries((await db.query('select kind, status, attempts from pass_notification where pass_id = $1', [passId])).rows.map((r) => [r.kind, r])));

/** Create a pass, check the guest in at `t`, and return everything the scenario needs. */
async function checkedIn(t = T0) {
  h.clock.now = t;
  const r = await resident();
  const pass = (await create(r)).json();
  const plate = plateOf();
  const res = await redeem(pass.qr, plate);
  expect(res.statusCode, res.body).toBe(201);
  return { r, pass, plate, session: res.json() };
}

describe('resident access', () => {
  it('sees only their unit: no sessions, occupancy, inventory or live events', async () => {
    const r = await resident();
    for (const url of ['/v1/sessions', '/v1/occupancy', '/v1/slots?site=DEMO-01', '/v1/inventory/export', '/v1/events', '/v1/rate-plans', '/v1/audit']) {
      expect((await h.app.inject({ method: 'GET', url, headers: r.h })).statusCode, url).toBe(403);
    }
    const me = (await h.app.inject({ method: 'GET', url: '/v1/me', headers: r.h })).json();
    expect(me).toMatchObject({ roles: ['resident'], unit: { name: expect.stringContaining('Unit') } });
    expect((await h.app.inject({ method: 'POST', url: '/v1/sessions', headers: idem(r), payload: { site: 'DEMO-01', plate: { display: 'X1' } } })).statusCode).toBe(403);
  });

  it('cannot redeem passes, scan, or manage users', async () => {
    const r = await resident();
    expect((await redeem('OPP1.x.1.y', 'AAA111', r)).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'POST', url: '/v1/users', headers: idem(r), payload: { email: 'x@example.com', roles: ['admin'] } })).statusCode).toBe(403);
  });
});

describe('creating a pass', () => {
  it('issues a QR that lasts 2 hours and needs a way to reach the guest', async () => {
    h.clock.now = T0;
    const r = await resident();
    const res = await create(r);
    expect(res.statusCode).toBe(201);
    const p = res.json();
    expect(p.qr).toMatch(/^OPP2\|/);
    expect(p.verifyCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/); // random code, printed under the QR as well
    expect(new Date(p.expiresAt).getTime() - T0.getTime()).toBe(2 * 3_600_000);
    expect(p).toMatchObject({ status: 'active', displayStatus: 'active', guestName: 'Luis Invitado' });

    const r2 = await resident();
    expect((await create(r2, { guestPhone: undefined, guestEmail: undefined })).statusCode).toBe(400);
    expect((await create(r2, { guestPhone: '5512345678' })).statusCode).toBe(400); // not international format
  });

  it('allows one active pass per unit at a time', async () => {
    const r = await resident();
    expect((await create(r)).statusCode).toBe(201);
    const second = await create(r);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('active_pass_exists');
  });

  it('keeps the unit blocked while the guest is inside, and frees it after check-out', async () => {
    const { r, plate } = await checkedIn();
    expect((await create(r)).statusCode).toBe(409);
    expect((await checkout(plate)).statusCode).toBe(200);
    expect((await create(r)).statusCode).toBe(201);
  });

  it('lets the resident see the current pass with its QR, but not other units', async () => {
    const r = await resident();
    const other = await resident();
    const p = (await create(r)).json();
    expect((await h.app.inject({ method: 'GET', url: '/v1/passes/active', headers: r.h })).json().pass).toMatchObject({ id: p.id, qr: p.qr });
    expect((await h.app.inject({ method: 'GET', url: '/v1/passes/active', headers: other.h })).json().pass).toBeNull();
    expect((await h.app.inject({ method: 'POST', url: `/v1/passes/${p.id}/cancel`, headers: idem(other) })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'POST', url: `/v1/passes/${p.id}/regenerate`, headers: idem(other) })).statusCode).toBe(404);
  });
});

describe('QR lifetime and regeneration', () => {
  it('expires after 2 hours; a new QR is needed and the old one stops working', async () => {
    h.clock.now = T0;
    const r = await resident();
    const p = (await create(r)).json();
    h.clock.now = at(1.9);
    expect((await h.app.inject({ method: 'GET', url: `/v1/passes/lookup?token=${encodeURIComponent(p.qr)}`, headers: attendant.h })).json().valid).toBe(true);

    h.clock.now = at(2.01);
    const look = (await h.app.inject({ method: 'GET', url: `/v1/passes/lookup?token=${encodeURIComponent(p.qr)}`, headers: attendant.h })).json();
    expect(look).toMatchObject({ valid: false, reason: 'pass_expired' });
    const redeemed = await redeem(p.qr, plateOf());
    expect(redeemed.statusCode).toBe(410);
    expect(redeemed.json().error.code).toBe('pass_expired');
    const active = (await h.app.inject({ method: 'GET', url: '/v1/passes/active', headers: r.h })).json().pass;
    expect(active).toMatchObject({ displayStatus: 'expired', qr: null });
    expect((await create(r)).statusCode).toBe(409); // still the unit's one pass: regenerate it instead

    const fresh = (await h.app.inject({ method: 'POST', url: `/v1/passes/${p.id}/regenerate`, headers: idem(r) })).json();
    expect(fresh.qr).toBeTruthy();
    expect(fresh.qr).not.toBe(p.qr);
    expect(new Date(fresh.expiresAt).getTime() - at(2.01).getTime()).toBe(2 * 3_600_000);

    const old = await redeem(p.qr, plateOf());
    expect(old.statusCode).toBe(409);
    expect(old.json().error.code).toBe('pass_superseded');
    expect((await redeem(fresh.qr, plateOf())).statusCode).toBe(201);
  });

  it('cannot be regenerated once the guest has checked in', async () => {
    const { r, pass } = await checkedIn();
    const res = await h.app.inject({ method: 'POST', url: `/v1/passes/${pass.id}/regenerate`, headers: idem(r) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('pass_checked_in');
  });

  it('rejects forged or foreign QR codes', async () => {
    const r = await resident();
    const p = (await create(r)).json();
    const forged = p.qr.replace(/.$/, (c: string) => (c === 'A' ? 'B' : 'A'));
    expect((await redeem(forged, plateOf())).statusCode).toBe(400);
    expect((await redeem('TICKET123', plateOf())).statusCode).toBe(400);
    const fields = p.qr.split('|');
    fields[2] = '2';
    expect((await redeem(fields.join('|'), plateOf())).statusCode).toBe(400); // the signature covers every field, version included
  });
});

describe('cancelling', () => {
  it('works until the guest checks in, then frees the unit for a new pass', async () => {
    const r = await resident();
    const p = (await create(r)).json();
    const res = await h.app.inject({ method: 'POST', url: `/v1/passes/${p.id}/cancel`, headers: idem(r) });
    expect(res.json()).toMatchObject({ status: 'cancelled' });
    const used = await redeem(p.qr, plateOf());
    expect(used.json().error.code).toBe('pass_cancelled');
    expect((await create(r)).statusCode).toBe(201);
  });

  it('is refused after check-in', async () => {
    const { r, pass } = await checkedIn();
    const res = await h.app.inject({ method: 'POST', url: `/v1/passes/${pass.id}/cancel`, headers: idem(r) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('pass_checked_in');
  });
});

describe('at the gate', () => {
  it('scan opens a free session tied to the pass; check-out completes it', async () => {
    const { pass, plate, session } = await checkedIn();
    expect(session.pass).toMatchObject({ status: 'checked_in', unit: expect.any(Object) });
    expect(session.slot).toBeTruthy();
    expect((await redeem(pass.qr, plateOf())).json().error.code).toBe('pass_in_use');

    h.clock.now = at(3);
    const out = (await checkout(plate)).json();
    expect(out).toMatchObject({ minutes: 180, fee: { total: 0, hoaCharge: 0 } });
    expect(out.fee.lines).toEqual([{ label: 'resident_pass', amount: 0 }]);
    const done = (await h.app.inject({ method: 'GET', url: `/v1/passes/${pass.id}`, headers: supervisor.h })).json();
    expect(done).toMatchObject({ status: 'completed', overstayCharge: null });
    const events = (await h.app.inject({ method: 'GET', url: `/v1/sessions/${session.session.id}/events`, headers: attendant.h })).json();
    expect(events.map((e: { type: string }) => e.type)).toEqual(['check_in', 'slot_assigned', 'pass_redeemed', 'check_out']);
  });

  it('works without any rate plan on the site, and keeps the pass in its own site', async () => {
    const t = await signup(h.app, 'MX');
    await addUnit(h.app, t, 'Z-1');
    const rr = await addResident(h.app, t, 'Z-1');
    await h.app.db.withTenant(await tenantId(t.slug), (db) => db.query('update site set default_rate_plan_id = null'));
    const p = (await h.app.inject({ method: 'POST', url: '/v1/passes', headers: idem(rr), payload: guest })).json();
    const att = await addUser(h.app, t, 'attendant');
    const wrongSite = await h.app.inject({ method: 'POST', url: '/v1/passes/redeem', headers: idem(att), payload: { token: p.qr, site: 'NOPE', plate: { display: 'ZZZ111' } } });
    expect(wrongSite.statusCode).toBe(409);
    expect(wrongSite.json().error.code).toBe('pass_wrong_site');
    const ok = await h.app.inject({ method: 'POST', url: '/v1/passes/redeem', headers: idem(att), payload: { token: p.qr, site: 'DEMO-01', plate: { display: 'ZZZ111' } } });
    expect(ok.statusCode).toBe(201);
  });
});

describe('alerts on check-in and check-out', () => {
  it('tells the host when the guest arrives and when they leave', async () => {
    const { r, plate } = await checkedIn();
    const inMsg = await waitFor(() => h.notifier.to({ email: r.email }).find((m) => m.body.includes(plate)));
    expect(inMsg.subject).toBe('Tu invitado ha llegado'); // tenant locale es-MX
    expect(inMsg.body).toContain('Luis Invitado');
    expect(inMsg.to).toMatchObject({ email: r.email, phone: r.phone });

    h.clock.now = at(1.5);
    await checkout(plate);
    const outMsg = await waitFor(() => h.notifier.to({ email: r.email }).find((m) => m.subject === 'Tu invitado se ha ido' && m.body.includes(plate)));
    expect(outMsg.body).toContain('1h 30min');
  });

  it('can also alert the guest and supervisors when the tenant asks for it', async () => {
    const t = await signup(h.app, 'MX');
    const sup = await addUser(h.app, t, 'supervisor');
    const att = await addUser(h.app, t, 'attendant');
    await h.app.inject({ method: 'PATCH', url: '/v1/pass-policy', headers: t.h, payload: { alertRecipients: ['host', 'guest', 'supervisors'] } });
    await addUnit(h.app, t, 'Q-1');
    const rr = await addResident(h.app, t, 'Q-1');
    const p = (await h.app.inject({ method: 'POST', url: '/v1/passes', headers: idem(rr), payload: guest })).json();
    await h.app.inject({ method: 'POST', url: '/v1/passes/redeem', headers: idem(att), payload: { token: p.qr, site: 'DEMO-01', plate: { display: 'QQQ111' } } });
    await waitFor(() => h.notifier.to({ email: sup.email }).some((m) => m.body.includes('QQQ111')));
    await waitFor(() => h.notifier.to({ email: guest.guestEmail }).some((m) => m.body.includes('QQQ111')));
  });
});

/** An isolated tenant (own supervisor, attendant, resident, guest) so reminder runs see only this scenario. */
async function world(country = 'MX') {
  const t = await signup(h.app, country);
  const sup = await addUser(h.app, t, 'supervisor');
  const att = await addUser(h.app, t, 'attendant');
  await addUnit(h.app, t, 'W-1');
  const r = await addResident(h.app, t, 'W-1');
  const suffix = randomBytes(3).toString('hex');
  const g = { guestName: 'Luis Invitado', guestPhone: `+5255${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, guestEmail: `guest-${suffix}@example.com` };
  const checkIn = async (when: Date) => {
    h.clock.now = when;
    const pass = (await h.app.inject({ method: 'POST', url: '/v1/passes', headers: idem(r), payload: g })).json();
    const plate = plateOf();
    const res = await h.app.inject({ method: 'POST', url: '/v1/passes/redeem', headers: idem(att), payload: { token: pass.qr, site: 'DEMO-01', plate: { display: plate } } });
    expect(res.statusCode, res.body).toBe(201);
    return { pass, plate, session: res.json() };
  };
  return { t, sup, att, r, g, checkIn, cron: () => runCron(t), events: async (sid: string) => (await h.app.inject({ method: 'GET', url: `/v1/sessions/${sid}/events`, headers: att.h })).json() as { type: string; payload: Record<string, unknown> }[] };
}

describe('reminders and the 12-hour overstay notice', () => {
  it('messages the guest at 10 and 11 hours, then guest, host and supervisors at 12 hours with the HOA charge', async () => {
    const w = await world();
    const { pass, plate, session } = await w.checkIn(T0);
    const guestMsgs = () => h.notifier.to({ phone: w.g.guestPhone });

    h.clock.now = at(9.99);
    expect(await w.cron()).toMatchObject({ passes: 0 });
    expect(guestMsgs()).toHaveLength(0);

    h.clock.now = at(10);
    expect(await w.cron()).toMatchObject({ passes: 1, sent: 1 });
    expect(guestMsgs()).toHaveLength(1);
    expect(guestMsgs()[0]!.subject).toContain('10 horas');
    expect(guestMsgs()[0]!.body).toContain('12 horas');
    expect(guestMsgs()[0]!.body).toContain('5,000'); // the charge they are warned about
    expect(guestMsgs()[0]!.body).not.toContain('del estacionamiento'); // the 10h reminder does NOT yet tell them to move the car

    expect(await w.cron()).toMatchObject({ passes: 0 }); // idempotent: never sent twice
    expect(guestMsgs()).toHaveLength(1);

    h.clock.now = at(11);
    await w.cron();
    expect(guestMsgs()).toHaveLength(2);
    expect(guestMsgs()[1]!.subject).toContain('11 horas');

    h.clock.now = at(12);
    const before = h.notifier.sent.length;
    await w.cron();
    const fresh = h.notifier.sent.slice(before);
    const to = (email: string | null | undefined) => fresh.find((m) => m.to.email === email);
    expect(to(w.g.guestEmail)!.subject).toBe('Límite de estacionamiento alcanzado');
    expect(to(w.r.email)!.subject).toBe('Tu invitado excedió el límite de estacionamiento');
    expect(to(w.sup.email)!.subject).toContain('Límite de estacionamiento de visitas excedido');
    expect(fresh).toHaveLength(3); // guest, host, the supervisor: and not the owner or attendant
    // Every 12h overstay notice states the currency-formatted charge AND tells the host to move the vehicle.
    for (const m of fresh) { expect(m.body).toContain('$5,000.00'); expect(m.body).toContain('plataforma del HOA'); expect(m.body).toContain('el vehículo del estacionamiento'); }

    const events = await w.events(session.session.id);
    expect(events.find((e) => e.type === 'overstay_charge')!.payload).toMatchObject({ amount: 500000, currency: 'MXN', platform: 'hoa', status: 'pending' });
    expect((await h.app.inject({ method: 'GET', url: `/v1/passes/${pass.id}`, headers: w.sup.h })).json().overstayCharge).toBe(500000);

    await w.cron();
    expect(h.notifier.sent.length).toBe(before + 3); // nothing repeats

    // Checking out late records no second charge and reports the HOA charge instead of a fee.
    h.clock.now = at(12.5);
    const out = (await checkout(plate, w.att)).json();
    expect(out.fee).toMatchObject({ total: 0, hoaCharge: 500000 });
    expect((await w.events(session.session.id)).filter((e) => e.type === 'overstay_charge')).toHaveLength(1);
  });

  it('sends only the latest notice when the cron was late, never a burst of stale reminders', async () => {
    const w = await world();
    const { pass } = await w.checkIn(at(30));
    h.clock.now = at(30 + 12.5);
    await w.cron();
    expect(h.notifier.to({ email: w.g.guestEmail }).map((m) => m.subject)).toEqual(['Límite de estacionamiento alcanzado']);
    const n = await notifications(pass.id, w.t);
    expect(n.reminder_1.status).toBe('skipped');
    expect(n.reminder_2.status).toBe('skipped');
    expect(n.overstay.status).toBe('sent');
  });

  it('sends nothing for a suspended tenant', async () => {
    const w = await world();
    const { pass } = await w.checkIn(at(120));
    const id = await tenantId(w.t.slug);
    await h.app.db.withTenant(id, (db) => db.query("update tenant set suspended_at = now(), suspended_reason = 'test'"));
    h.clock.now = at(120 + 13);
    expect(await w.cron()).toMatchObject({ passes: 0 });
    expect(h.notifier.to({ email: w.g.guestEmail })).toHaveLength(0);
    expect(Object.keys(await notifications(pass.id, w.t))).toEqual(['checked_in']);
  });

  it('does not remind guests who already left', async () => {
    const w = await world();
    const { plate, pass } = await w.checkIn(at(60));
    h.clock.now = at(60 + 3);
    await checkout(plate, w.att);
    h.clock.now = at(60 + 13);
    expect(await w.cron()).toMatchObject({ passes: 0 });
    expect(h.notifier.to({ email: w.g.guestEmail })).toHaveLength(0);
    expect(Object.keys(await notifications(pass.id, w.t)).sort()).toEqual(['checked_in', 'checked_out']);
  });

  it('retries a failed send on the next run, once', async () => {
    const w = await world();
    const { pass } = await w.checkIn(at(90));
    h.clock.now = at(90 + 10);
    h.notifier.failing = true;
    try { await w.cron(); } finally { h.notifier.failing = false; }
    expect((await notifications(pass.id, w.t)).reminder_1).toMatchObject({ status: 'failed', attempts: 1 });
    await w.cron();
    expect((await notifications(pass.id, w.t)).reminder_1).toMatchObject({ status: 'sent', attempts: 2 });
    expect(h.notifier.to({ email: w.g.guestEmail })).toHaveLength(1);
  });

  it('honours the tenant policy (reminder hours, stay limit, charge) and rejects an inconsistent one', async () => {
    const w = await world('US');
    // The overstay default is keyed off currency: a USD tenant seeds 0 (an MXN tenant seeds 500000, asserted above).
    expect((await h.app.inject({ method: 'GET', url: '/v1/pass-policy', headers: w.t.h })).json().policy.overstayCharge).toBe(0);
    const bad = await h.app.inject({ method: 'PATCH', url: '/v1/pass-policy', headers: w.t.h, payload: { reminderHours: [11, 10] } });
    expect(bad.statusCode).toBe(400);
    const ok = await h.app.inject({ method: 'PATCH', url: '/v1/pass-policy', headers: w.t.h, payload: { qrTtlMin: 60, maxStayHours: 4, reminderHours: [2, 3], overstayCharge: 2500 } });
    expect(ok.json().policy).toMatchObject({ qrTtlMin: 60, maxStayHours: 4 });
    h.clock.now = at(200);
    const pass = (await h.app.inject({ method: 'POST', url: '/v1/passes', headers: idem(w.r), payload: w.g })).json();
    expect(new Date(pass.expiresAt).getTime() - at(200).getTime()).toBe(3_600_000);
    await h.app.inject({ method: 'POST', url: '/v1/passes/redeem', headers: idem(w.att), payload: { token: pass.qr, site: 'DEMO-01', plate: { display: 'POL111' } } });
    h.clock.now = at(200 + 2);
    await w.cron();
    const m = h.notifier.to({ email: w.g.guestEmail })[0]!;
    expect(m.subject).toBe('Parking reminder: 2 hours'); // US tenant => English
    expect(m.body).toContain('within 4 hours');
    expect(m.body).toContain('$25.00');
  });
});

describe('cron endpoint', () => {
  it('requires the cron secret', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/v1/cron/pass-reminders' })).statusCode).toBe(401);
  });
});
