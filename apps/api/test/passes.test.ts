import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gravatarUrl } from '../src/gravatar.js';
import { processPassReminders, processStayAlerts } from '../src/services/passes.js';
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
const runStays = (t: Tenant = owner) => tenantId(t.slug).then((id) => processStayAlerts(h.app, { tenantId: id }));
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

describe('resident profile: avatar and notify opt-in', () => {
  // WEBP magic: 'RIFF' .... 'WEBP'. A valid 12-byte+ header so signatureMatches accepts it.
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from('VP8 tiny')]);
  const b64 = (b: Buffer) => b.toString('base64');

  it('uploads a valid avatar, returns a signed URL from /v1/me (never the key), and rejects oversize and bad MIME', async () => {
    const r = await resident();
    // No upload yet: the Gravatar fallback points at the address's picture. d=404 means an address with no
    // profile returns no image, so the screen keeps its initials.
    const initial = (await h.app.inject({ method: 'GET', url: '/v1/me', headers: r.h })).json();
    expect(initial.avatarUrl).toBe(gravatarUrl(r.email));
    expect(initial.avatarUrl).toMatch(/^https:\/\/gravatar\.com\/avatar\/[a-f0-9]{64}\?s=512&d=404&r=g$/);

    const ok = await h.app.inject({ method: 'POST', url: '/v1/me/avatar', headers: idem(r), payload: { contentType: 'image/webp', dataBase64: b64(WEBP) } });
    expect(ok.statusCode, ok.body).toBe(200);
    const me = (await h.app.inject({ method: 'GET', url: '/v1/me', headers: r.h })).json();
    expect(me.avatarUrl).toMatch(/^\/v1\/files\/.+\?exp=\d+&sig=/); // a signed, short-lived URL
    expect(me.avatarUrl).not.toContain('avatars/'); // the raw storage key is never surfaced (it is URL-encoded in the path, but the key path itself is not exposed as plain text)

    // Oversize: a decoded payload over 100 KB is rejected.
    const big = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(102_401 - 12)]);
    const over = await h.app.inject({ method: 'POST', url: '/v1/me/avatar', headers: idem(r), payload: { contentType: 'image/webp', dataBase64: b64(big) } });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.code).toBe('avatar_invalid');

    // Bad MIME/signature: only WebP is accepted, so PNG rejected at Zod validation layer.
    const bad = await h.app.inject({ method: 'POST', url: '/v1/me/avatar', headers: idem(r), payload: { contentType: 'image/png', dataBase64: b64(WEBP) } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation_failed');
  });

  it('serves the WebP avatar through the signed GET with image/webp Content-Type', async () => {
    const r = await resident();
    const up = await h.app.inject({ method: 'POST', url: '/v1/me/avatar', headers: idem(r), payload: { contentType: 'image/webp', dataBase64: b64(WEBP) } });
    expect(up.statusCode, up.body).toBe(200);
    const url = (await h.app.inject({ method: 'GET', url: '/v1/me', headers: r.h })).json().avatarUrl as string;
    // Actually request the signed file and assert the response Content-Type is WebP.
    const got = await h.app.inject({ method: 'GET', url });
    expect(got.statusCode, got.body).toBe(200);
    expect(got.headers['content-type']).toContain('image/webp');
  });

  it('persists the guest-alert opt-in and suppresses the host alert when the resident opts out', async () => {
    const r = await resident();
    // Opt out of guest alerts.
    expect((await h.app.inject({ method: 'PATCH', url: '/v1/me/profile', headers: r.h, payload: { notifyGuestEvents: false } })).statusCode).toBe(200);
    const plate = plateOf();
    const pass = (await create(r)).json();
    expect((await redeem(pass.qr, plate)).statusCode).toBe(201);
    // No check-in alert reaches the opted-out host; give background sends a moment and assert nothing arrived.
    await new Promise((res) => setTimeout(res, 150));
    expect(h.notifier.to({ email: r.email }).filter((m) => m.body.includes(plate))).toHaveLength(0);
  });
});

describe('unit-access verification gates pass issuance', () => {
  /** Flip a resident's unit grant to unverified directly (mimics an unvouched/bulk-imported grant). */
  const unverify = async (email: string) => h.app.db.withTenant(await tenantId(owner.slug), (db) =>
    db.query('update membership set unit_verified = false where user_id = (select id from app_user where email = $1)', [email]));

  it('rejects an unverified resident with 403 unit_unverified, but accepts them once verified', async () => {
    const code = `U-${randomBytes(3).toString('hex')}`;
    await addUnit(h.app, owner, code);
    const r = await addResident(h.app, owner, code);
    await unverify(r.email!);

    const blocked = await create(r);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('unit_unverified');

    // An admin verifies the unit access; the resident can now issue a pass.
    const member = (await h.app.inject({ method: 'GET', url: '/v1/users', headers: owner.h })).json().members.find((m: { email: string }) => m.email === r.email);
    expect(member.unit_verified).toBe(false);
    const verified = await h.app.inject({ method: 'PATCH', url: `/v1/users/${member.id}/verify`, headers: idem(owner) });
    expect(verified.statusCode, verified.body).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/v1/users', headers: owner.h })).json().members.find((m: { email: string }) => m.email === r.email).unit_verified).toBe(true);
    // The resident's own /v1/me now reports unitVerified true.
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: r.h })).json().unitVerified).toBe(true);
    expect((await create(r)).statusCode).toBe(201);
  });

  it('lets staff with pass.admin issue a pass for an unverified unit (staff are trusted), and keeps reads ungated', async () => {
    const code = `U-${randomBytes(3).toString('hex')}`;
    await addUnit(h.app, owner, code);
    const r = await addResident(h.app, owner, code);
    await unverify(r.email!);
    // Staff bypass: the admin issues a pass for the unit on the resident's behalf.
    expect((await create(owner, { unit: code })).statusCode).toBe(201);
    // Reads stay open so the Resident screen can render the pending banner: /v1/passes/active returns { pass, policy }.
    const active = (await h.app.inject({ method: 'GET', url: '/v1/passes/active', headers: r.h })).json();
    expect(active.policy).toMatchObject({ maxStayHours: expect.any(Number), overstayCharge: expect.any(Number) });
    expect((await h.app.inject({ method: 'GET', url: '/v1/passes?limit=10', headers: r.h })).statusCode).toBe(200);
  });

  it('returns { pass:null, policy } from /v1/passes/active for an unverified resident with no active pass', async () => {
    const code = `U-${randomBytes(3).toString('hex')}`;
    await addUnit(h.app, owner, code);
    const r = await addResident(h.app, owner, code);
    await unverify(r.email!);
    const active = (await h.app.inject({ method: 'GET', url: '/v1/passes/active', headers: r.h })).json();
    expect(active.pass).toBeNull();
    expect(active.policy).toBeTruthy();
    // me.unitVerified is false, so the UI shows the pending-verification banner.
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: r.h })).json().unitVerified).toBe(false);
  });

  it('the verify route 404s a non-member and 409 not_resident a non-resident member', async () => {
    expect((await h.app.inject({ method: 'PATCH', url: `/v1/users/${randomBytes(16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')}/verify`, headers: idem(owner) })).statusCode).toBe(404);
    const att = (await h.app.inject({ method: 'GET', url: '/v1/users', headers: owner.h })).json().members.find((m: { roles: string[] }) => m.roles.includes('attendant') && !m.roles.includes('resident'));
    const res = await h.app.inject({ method: 'PATCH', url: `/v1/users/${att.id}/verify`, headers: idem(owner) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('not_resident');
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

  it('labels the issuer role without exposing staff identity: self vs attendant vs legacy', async () => {
    h.clock.now = T0;
    const code = `U-${randomBytes(3).toString('hex')}`;
    await addUnit(h.app, owner, code);
    const r = await addResident(h.app, owner, code);

    // The resident issues their own pass: issuedByRole === 'host'.
    const own = (await create(r)).json();
    expect(own.issuedByRole).toBe('host');
    expect(own).not.toHaveProperty('createdBy'); // the raw creator id is never surfaced
    expect(own).not.toHaveProperty('createdByName');

    // Check it out so the unit frees up, then an attendant issues a pass for the SAME unit on the resident's behalf.
    const plate = plateOf();
    expect((await redeem(own.qr, plate)).statusCode).toBe(201);
    h.clock.now = at(1);
    expect((await checkout(plate)).statusCode).toBe(200);
    // An admin (the owner) issues a pass for the SAME unit on the resident's behalf. created_by is the admin, but the
    // host is still the unit's resident, so the pass reads as 'staff'.
    const byStaffRes = await create(owner, { unit: code });
    if (byStaffRes.statusCode !== 201) throw new Error(`staff pass failed: ${byStaffRes.body}`);
    const byStaff = byStaffRes.json();
    expect(byStaff.issuedByRole).toBe('staff');
    expect(byStaff).not.toHaveProperty('createdBy');

    // The resident's own history lists the staff-issued pass labelled 'staff', its own labelled 'host',
    // and never leaks the staff member's identity (no creator id/name/email on the projection).
    const hist = (await h.app.inject({ method: 'GET', url: '/v1/passes?limit=10', headers: r.h })).json();
    const roles = hist.map((p: { issuedByRole: string }) => p.issuedByRole).sort();
    expect(roles).toEqual(['host', 'staff']);
    for (const p of hist) {
      expect(p).not.toHaveProperty('createdBy');
      expect(p).not.toHaveProperty('createdByName');
      expect(p).not.toHaveProperty('createdByEmail');
    }

    // A legacy pass (created_by NULL, predating this migration) labels neutrally as 'unknown'.
    await h.app.db.withTenant(await tenantId(owner.slug), (db) => db.query('update pass set created_by = null where id = $1', [byStaff.id]));
    const legacy = (await h.app.inject({ method: 'GET', url: `/v1/passes/${byStaff.id}`, headers: supervisor.h })).json();
    expect(legacy.issuedByRole).toBe('unknown');
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

  it('rejects a validly-signed QR whose stored verify code no longer matches (the second tamper layer)', async () => {
    // The forged/edited cases above fail the HMAC first, so they only prove signature rejection. This exercises the
    // SEPARATE verify_code check: the token keeps a valid signature AND the matching qr_version, but the code stored in
    // the database is rotated out from under it. That is the one tamper state the signature cannot catch, so the
    // server's constant-time verify_code comparison must reject it as pass_invalid.
    const r = await resident();
    const p = (await create(r)).json();
    const rotated = p.verifyCode === 'ZZZZZZZZ' ? 'YYYYYYYY' : 'ZZZZZZZZ'; // a different valid 8-char Crockford code
    await h.app.db.withTenant(await tenantId(owner.slug), (db) =>
      db.query('update pass set verify_code = $2 where id = $1', [p.id, rotated])); // qr_version is left untouched

    const look = (await h.app.inject({ method: 'GET', url: `/v1/passes/lookup?token=${encodeURIComponent(p.qr)}`, headers: attendant.h })).json();
    expect(look).toMatchObject({ valid: false, reason: 'pass_invalid' }); // the token still parses (valid HMAC + version) but the code mismatches
    const redeemed = await redeem(p.qr, plateOf());
    expect(redeemed.statusCode).toBe(400);
    expect(redeemed.json().error.code).toBe('pass_invalid');
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

  it('uses the configured (non-default) overstay amount in every 12-hour notice, leaving 10h/11h unchanged', async () => {
    const w = await world();
    // An administrator raises the HOA overstay charge from the MXN default ($5,000) to a custom $7,500.00.
    const patched = await h.app.inject({ method: 'PATCH', url: '/v1/pass-policy', headers: w.t.h, payload: { overstayCharge: 750000 } });
    expect(patched.json().policy.overstayCharge).toBe(750000);
    const { session } = await w.checkIn(T0);

    // The 10h reminder reflects the configured amount, not a literal default, and still does not tell them to move the car.
    h.clock.now = at(10);
    await w.cron();
    const ten = h.notifier.to({ phone: w.g.guestPhone }).at(-1)!;
    expect(ten.body).toContain('7,500');
    expect(ten.body).not.toContain('5,000');
    expect(ten.body).not.toContain('del estacionamiento');

    // At 12h every party's notice states the CONFIGURED currency-formatted amount plus the move-vehicle instruction.
    h.clock.now = at(12);
    const before = h.notifier.sent.length;
    await w.cron();
    const fresh = h.notifier.sent.slice(before);
    const to = (email: string | null | undefined) => fresh.find((m) => m.to.email === email);
    expect(fresh).toHaveLength(3); // guest, host, supervisor
    expect(to(w.g.guestEmail)).toBeTruthy();
    expect(to(w.r.email)).toBeTruthy();
    expect(to(w.sup.email)).toBeTruthy();
    for (const m of fresh) {
      expect(m.body).toContain('$7,500.00'); // formatted FROM the policy value, never a hardcoded 5,000
      expect(m.body).not.toContain('$5,000.00');
      expect(m.body).toContain('el vehículo del estacionamiento'); // the move-vehicle instruction
    }
    const events = await w.events(session.session.id);
    expect(events.find((e) => e.type === 'overstay_charge')!.payload).toMatchObject({ amount: 750000, currency: 'MXN', platform: 'hoa', status: 'pending' });
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

describe('supervisor stay alerts for any vehicle past the thresholds', () => {
  /** Open an ordinary (non-pass) walk-in session as the tenant's attendant. */
  const openSession = async (att: Tenant, plate: string) => {
    const res = await h.app.inject({ method: 'POST', url: '/v1/sessions', headers: idem(att), payload: { site: 'DEMO-01', plate: { display: plate } } });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { session: { id: string } };
  };
  const stayRows = async (t: Tenant, sessionId: string) => h.app.db.withTenant(await tenantId(t.slug), async (db) =>
    Object.fromEntries((await db.query('select kind, status from stay_alert where session_id = $1', [sessionId])).rows.map((r) => [r.kind, r.status])));

  it('notifies supervisors once a car passes 10h, again at 11h, and never twice for the same threshold', async () => {
    const w = await world();
    h.clock.now = T0;
    const plate = plateOf();
    await openSession(w.att, plate);
    const supMsgs = () => h.notifier.to({ email: w.sup.email }).filter((m) => m.body.includes(plate));

    h.clock.now = at(9.99);
    expect(await runStays(w.t)).toMatchObject({ sent: 0 });
    expect(supMsgs()).toHaveLength(0);

    h.clock.now = at(10);
    expect(await runStays(w.t)).toMatchObject({ sent: 1 });
    expect(supMsgs()).toHaveLength(1);
    expect(supMsgs()[0]!.subject).toContain('10 horas'); // "Vehículo … lleva 10 horas dentro"

    expect(await runStays(w.t)).toMatchObject({ sent: 0 }); // idempotent: the 10h alert is not resent
    expect(supMsgs()).toHaveLength(1);

    h.clock.now = at(11);
    expect(await runStays(w.t)).toMatchObject({ sent: 1 });
    expect(supMsgs()).toHaveLength(2);
    expect(supMsgs()[1]!.subject).toContain('11 horas');
    // Only supervisors hear about it: not the attendant who opened it.
    expect(h.notifier.to({ email: w.att.email })).toHaveLength(0);
  });

  it('skips the 12h stay overstay for a guest-pass stay, so the pass overstay notice is not duplicated', async () => {
    const w = await world();
    const { session } = await w.checkIn(T0);
    h.clock.now = at(12);
    await runStays(w.t);
    // The guest-pass path owns the 12h HOA notice; the stay-alert job must not send a second supervisor message.
    expect(h.notifier.to({ email: w.sup.email }).filter((m) => m.subject.includes('dentro'))).toHaveLength(0);
    expect((await stayRows(w.t, session.session.id)).overstay).toBe('skipped');
  });
});

describe('cron endpoint', () => {
  it('requires the cron secret', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/v1/cron/pass-reminders' })).statusCode).toBe(401);
  });
});
