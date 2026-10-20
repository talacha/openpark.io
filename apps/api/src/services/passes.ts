import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { emit, type Db } from '../db.js';
import { HttpError, type Ctx } from '../http.js';
import { render, type MessageKey } from '../notify/messages.js';
import type { Recipient } from '../notify/notifier.js';
import type { App } from '../server.js';
import { addEvent, checkIn, type CheckInInput } from './sessions.js';

type After = (fn: () => void | Promise<void>) => void;

/* ---------------------------------------------------------------------------------------------- */
/* Policy: per-tenant, stored in tenant.settings.passPolicy                                        */
/* ---------------------------------------------------------------------------------------------- */

export const PassPolicy = z.object({
  /** A QR is valid this long after it is generated; it must be regenerated if the car has not checked in. */
  qrTtlMin: z.number().int().min(5).max(24 * 60).default(120),
  /** Longest stay covered by a pass. After this the overstay charge is announced. */
  maxStayHours: z.number().min(1).max(72).default(12),
  /** Guest reminders, in hours after check-in. */
  reminderHours: z.tuple([z.number().min(0.1), z.number().min(0.1)]).default([10, 11]),
  /** Minor units of the tenant currency, billed on the HOA platform. 0 disables the charge notice amount. */
  overstayCharge: z.number().int().min(0).default(0),
  /** Who is alerted at check-in and check-out. */
  alertRecipients: z.array(z.enum(['host', 'guest', 'supervisors'])).default(['host']),
}).refine((p) => p.reminderHours[0] < p.reminderHours[1] && p.reminderHours[1] < p.maxStayHours, {
  message: 'reminders must be increasing and earlier than maxStayHours',
});
export type PassPolicy = z.infer<typeof PassPolicy>;

export const DEFAULT_POLICY: PassPolicy = { qrTtlMin: 120, maxStayHours: 12, reminderHours: [10, 11], overstayCharge: 0, alertRecipients: ['host'] };

export async function loadPolicy(db: Db): Promise<{ policy: PassPolicy; currency: string; locale: string }> {
  const t = (await db.query('select settings, currency, default_locale from tenant')).rows[0];
  const parsed = PassPolicy.safeParse({ ...DEFAULT_POLICY, ...(t.settings?.passPolicy ?? {}) });
  return { policy: parsed.success ? parsed.data : DEFAULT_POLICY, currency: t.currency.trim(), locale: t.default_locale };
}

/* ---------------------------------------------------------------------------------------------- */
/* QR tokens: derived from the pass id and its qr_version, so they are never stored and a           */
/* regenerated QR invalidates the previous one.                                                    */
/* ---------------------------------------------------------------------------------------------- */

const PREFIX = 'OPP1';
const sign = (secret: string, id: string, version: number) => createHmac('sha256', secret).update(`pass:${id}:${version}`).digest('base64url').slice(0, 24);

export const passToken = (secret: string, id: string, version: number) => `${PREFIX}.${id}.${version}.${sign(secret, id, version)}`;

export function parsePassToken(secret: string, token: string): { id: string; version: number } | null {
  const [prefix, id, v, sig, ...rest] = token.trim().split('.');
  if (prefix !== PREFIX || !id || !v || !sig || rest.length || !/^[0-9a-f-]{36}$/.test(id) || !/^\d+$/.test(v)) return null;
  const want = Buffer.from(sign(secret, id, Number(v)));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want) ? { id, version: Number(v) } : null;
}

/* ---------------------------------------------------------------------------------------------- */
/* Presentation                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

interface PassRow {
  id: string; status: 'active' | 'checked_in' | 'completed' | 'cancelled'; qr_version: number; expires_at: Date; created_at: Date;
  checked_in_at: Date | null; completed_at: Date | null; cancelled_at: Date | null; guest_name: string; guest_phone: string | null;
  guest_email: string | null; plate_hint: string | null; unit_code: string; unit_name: string; site_code: string; overstay_charge: number | null;
  host_name?: string | null; host_email?: string | null;
}

const PASS_SQL = `select p.*, u.code as unit_code, u.name as unit_name, s.code as site_code, h.name as host_name, h.email as host_email
  from pass p join unit u on u.id = p.unit_id join site s on s.id = p.site_id join app_user h on h.id = p.host_user_id`;

export function presentPass(secret: string, p: PassRow, now: Date, includeQr: boolean) {
  const expired = p.status === 'active' && p.expires_at.getTime() <= now.getTime();
  const displayStatus = expired ? 'expired' : p.status;
  return {
    id: p.id, status: p.status, displayStatus,
    unit: { code: p.unit_code, name: p.unit_name }, site: p.site_code,
    guestName: p.guest_name, guestPhone: p.guest_phone, guestEmail: p.guest_email, plateHint: p.plate_hint,
    host: p.host_name || p.host_email || null,
    createdAt: p.created_at, expiresAt: p.expires_at, checkedInAt: p.checked_in_at, completedAt: p.completed_at, cancelledAt: p.cancelled_at,
    overstayCharge: p.overstay_charge,
    // Only a live, unredeemed pass has a QR; an expired one must be regenerated.
    qr: includeQr && displayStatus === 'active' ? passToken(secret, p.id, p.qr_version) : null,
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Resident operations                                                                             */
/* ---------------------------------------------------------------------------------------------- */

export const NewPass = z.object({
  guestName: z.string().trim().min(1).max(80),
  guestPhone: z.string().regex(/^\+[1-9]\d{7,14}$/, 'use international format, e.g. +525512345678').optional(),
  guestEmail: z.string().email().optional(),
  plateHint: z.string().max(20).optional(),
  /** Staff creating a pass on a resident's behalf name the unit; residents always use their own. */
  unit: z.string().optional(),
}).refine((b) => b.guestPhone || b.guestEmail, { message: 'a phone number or email is needed to reach the guest' });

async function unitFor(db: Db, ctx: Ctx, code?: string) {
  const id = ctx.role === 'resident' ? ctx.unitId : null;
  const r = id
    ? await db.query('select id, code, name, site_id from unit where id = $1', [id])
    : code ? await db.query('select id, code, name, site_id from unit where code = $1', [code]) : null;
  if (!r?.rows[0]) throw new HttpError(ctx.role === 'resident' ? 403 : 400, 'unit_required', ctx.role === 'resident' ? 'Your account is not linked to a unit' : 'Name the unit this pass is for');
  return r.rows[0] as { id: string; code: string; name: string; site_id: string | null };
}

/** A resident may only touch passes of their own unit; staff with pass.admin may touch any. */
function assertOwns(ctx: Ctx, p: { unit_id: string }, can: (perm: 'pass.admin') => boolean) {
  if (ctx.role === 'resident' ? p.unit_id !== ctx.unitId : !can('pass.admin')) throw new HttpError(404, 'pass_not_found', 'No such pass');
}

export async function createPass(app: App, db: Db, ctx: Ctx, input: z.infer<typeof NewPass>) {
  const unit = await unitFor(db, ctx, input.unit);
  const sites = (await db.query('select id from site where retired_at is null order by code')).rows;
  const siteId = unit.site_id ?? (sites.length === 1 ? sites[0].id : null);
  if (!siteId) throw new HttpError(409, 'site_required', 'This unit is not assigned to a site yet');
  const host = ctx.role === 'resident' ? ctx.userId
    : (await db.query("select user_id from membership where unit_id = $1 and role = 'resident' limit 1", [unit.id])).rows[0]?.user_id ?? ctx.userId;
  if (!host) throw new HttpError(400, 'host_required', 'A pass needs a resident host');

  const { policy } = await loadPolicy(db);
  const now = app.now();
  // A savepoint keeps the transaction usable after the unique-index violation so we can report who holds the unit.
  await db.query('savepoint new_pass');
  try {
    const r = await db.query(
      `insert into pass (tenant_id, site_id, unit_id, host_user_id, guest_name, guest_phone, guest_email, plate_hint, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [ctx.tenantId, siteId, unit.id, host, input.guestName, input.guestPhone ?? null, input.guestEmail ?? null, input.plateHint ?? null,
        new Date(now.getTime() + policy.qrTtlMin * 60_000)]);
    await db.query('release savepoint new_pass');
    return getPass(app, db, r.rows[0].id, now, true);
  } catch (e) {
    if ((e as { constraint?: string }).constraint === 'pass_one_active_per_unit') {
      await db.query('rollback to savepoint new_pass');
      const cur = (await db.query("select id, status from pass where unit_id = $1 and status in ('active','checked_in')", [unit.id])).rows[0];
      throw new HttpError(409, 'active_pass_exists', 'This unit already has an active pass. Cancel it or wait for check-out.', { passId: cur?.id, status: cur?.status });
    }
    throw e;
  }
}

export async function getPass(app: App, db: Db, id: string, now: Date, includeQr: boolean) {
  const row = (await db.query(`${PASS_SQL} where p.id = $1`, [id])).rows[0] as PassRow | undefined;
  if (!row) throw new HttpError(404, 'pass_not_found', 'No such pass');
  return presentPass(app.cfg.JWT_SECRET, row, now, includeQr);
}

export async function listPasses(app: App, db: Db, ctx: Ctx, canAdmin: boolean, status?: string, limit = 25) {
  const rows = (await db.query(
    `${PASS_SQL} where ($1::uuid is null or p.unit_id = $1) and ($2::text is null or p.status = $2) order by p.created_at desc limit $3`,
    [ctx.role === 'resident' ? ctx.unitId : null, status ?? null, limit])).rows as PassRow[];
  if (ctx.role !== 'resident' && !canAdmin) throw new HttpError(403, 'forbidden', 'Not allowed to list passes');
  const now = app.now();
  return rows.map((r) => presentPass(app.cfg.JWT_SECRET, r, now, ctx.role === 'resident'));
}

async function lockPass(db: Db, id: string) {
  const p = (await db.query('select * from pass where id = $1 for update', [id])).rows[0];
  if (!p) throw new HttpError(404, 'pass_not_found', 'No such pass');
  return p as { id: string; unit_id: string; status: string; qr_version: number; expires_at: Date; site_id: string; guest_name: string; session_id: string | null };
}

/** Issue a fresh QR (new 2-hour window). The previous QR stops working. Only for passes not yet checked in. */
export async function regeneratePass(app: App, db: Db, ctx: Ctx, canAdmin: (p: 'pass.admin') => boolean, id: string) {
  const p = await lockPass(db, id);
  assertOwns(ctx, p, canAdmin);
  if (p.status === 'checked_in') throw new HttpError(409, 'pass_checked_in', 'The guest has already checked in');
  if (p.status !== 'active') throw new HttpError(409, `pass_${p.status}`, `This pass is ${p.status}`);
  const { policy } = await loadPolicy(db);
  const now = app.now();
  await db.query('update pass set qr_version = qr_version + 1, expires_at = $2 where id = $1', [id, new Date(now.getTime() + policy.qrTtlMin * 60_000)]);
  return getPass(app, db, id, now, ctx.role === 'resident');
}

export async function cancelPass(app: App, db: Db, ctx: Ctx, canAdmin: (p: 'pass.admin') => boolean, id: string) {
  const p = await lockPass(db, id);
  assertOwns(ctx, p, canAdmin);
  if (p.status === 'checked_in') throw new HttpError(409, 'pass_checked_in', 'The guest has already checked in; a pass cannot be cancelled after check-in');
  if (p.status !== 'active') throw new HttpError(409, `pass_${p.status}`, `This pass is already ${p.status}`);
  await db.query("update pass set status = 'cancelled', cancelled_at = $2 where id = $1", [id, app.now()]);
  return getPass(app, db, id, app.now(), false);
}

/* ---------------------------------------------------------------------------------------------- */
/* At the gate                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

type Checked = { pass: Awaited<ReturnType<typeof lockPass>>; reason: string | null };

/** Why a scanned token cannot be used right now, or null when it can. */
async function validate(app: App, db: Db, token: string, lock: boolean): Promise<Checked> {
  const parsed = parsePassToken(app.cfg.JWT_SECRET, token);
  if (!parsed) throw new HttpError(400, 'pass_invalid', 'This QR is not an OpenPark guest pass');
  const p = lock ? await lockPass(db, parsed.id) : (await db.query('select * from pass where id = $1', [parsed.id])).rows[0];
  if (!p) throw new HttpError(404, 'pass_not_found', 'No such pass');
  let reason: string | null = null;
  if (p.status === 'cancelled') reason = 'pass_cancelled';
  else if (p.status === 'completed') reason = 'pass_completed';
  else if (p.status === 'checked_in') reason = 'pass_in_use';
  else if (p.qr_version !== parsed.version) reason = 'pass_superseded';
  else if (p.expires_at.getTime() <= app.now().getTime()) reason = 'pass_expired';
  return { pass: p, reason };
}

const REASON_TEXT: Record<string, [number, string]> = {
  pass_cancelled: [409, 'This pass was cancelled by the resident'],
  pass_completed: [409, 'This pass was already used'],
  pass_in_use: [409, 'The guest of this pass is already inside'],
  pass_superseded: [409, 'This QR was replaced by a newer one; ask the resident to show the current QR'],
  pass_expired: [410, 'This QR has expired; the resident must regenerate it'],
};

/** Preview for the scanner: who the pass is for and whether it can be redeemed, with no side effects. */
export async function lookupPass(app: App, db: Db, token: string) {
  const { pass, reason } = await validate(app, db, token, false);
  return { valid: reason === null, reason, pass: await getPass(app, db, pass.id, app.now(), false) };
}

export interface RedeemInput extends Omit<CheckInInput, 'site'> { token: string; site: string }

/** Scan at the gate: turns a valid pass into an open session, free of charge within the pass's stay limit. */
export async function redeemPass(app: App, db: Db, ctx: Ctx, after: After, input: RedeemInput) {
  const { pass, reason } = await validate(app, db, input.token, true);
  if (reason) throw new HttpError(REASON_TEXT[reason]![0], reason, REASON_TEXT[reason]![1]);
  const site = (await db.query('select code from site where id = $1', [pass.site_id])).rows[0];
  if (site.code !== input.site) throw new HttpError(409, 'pass_wrong_site', `This pass is for site ${site.code}`);

  const { token: _t, ...rest } = input;
  const out = await checkIn(app, db, ctx, after, rest, { pass: { id: pass.id, guestName: pass.guest_name } });
  await db.query("update pass set status = 'checked_in', checked_in_at = $2, session_id = $3 where id = $1", [pass.id, app.now(), out.session.id]);
  await addEvent(db, ctx, out.session.id, 'pass_redeemed', { passId: pass.id, guest: pass.guest_name });
  await queueNotification(app, db, ctx, after, pass.id, 'checked_in');
  return { ...out, pass: await getPass(app, db, pass.id, app.now(), false) };
}

/** Called by check-out: completes the pass, records any overstay charge and alerts the host. */
export async function completePass(app: App, db: Db, ctx: Ctx, after: After, session: { id: string; pass_id: string; in_at: Date }, now: Date) {
  const { policy } = await loadPolicy(db);
  const minutes = Math.floor((now.getTime() - session.in_at.getTime()) / 60_000);
  const over = minutes > policy.maxStayHours * 60;
  const p = (await db.query('select overstay_charge from pass where id = $1', [session.pass_id])).rows[0];
  const charge = over ? (p.overstay_charge ?? policy.overstayCharge) : null;
  await db.query("update pass set status = 'completed', completed_at = $2, overstay_charge = coalesce(overstay_charge, $3) where id = $1", [session.pass_id, now, charge]);
  if (over && p.overstay_charge === null) await recordOverstay(app, db, ctx, after, session.pass_id, session.id, charge ?? 0);
  await queueNotification(app, db, ctx, after, session.pass_id, 'checked_out');
  return { over, charge, minutes, maxStayHours: policy.maxStayHours };
}

/** Pass fees are waived; what is reported instead is the HOA charge a stay beyond the limit will incur. */
export async function passFee(db: Db, session: { in_at: Date }, now: Date) {
  const { policy } = await loadPolicy(db);
  const minutes = Math.floor((now.getTime() - session.in_at.getTime()) / 60_000);
  const over = minutes > policy.maxStayHours * 60;
  return {
    minutes, total: 0, tax: 0, lines: [{ label: 'resident_pass', amount: 0 }],
    hoaCharge: over ? policy.overstayCharge : 0, maxStayHours: policy.maxStayHours,
  };
}

async function recordOverstay(app: App, db: Db, ctx: Ctx, after: After, passId: string, sessionId: string, amount: number) {
  const { currency } = await loadPolicy(db);
  await db.query(
    'insert into session_event (tenant_id, session_id, type, payload) values ($1,$2,$3,$4)',
    [ctx.tenantId, sessionId, 'overstay_charge', JSON.stringify({ passId, amount, currency, platform: 'hoa', status: 'pending' })]);
  await emit(db, ctx.tenantId, 'pass.overstay', { passId, sessionId, amount, currency });
  after(() => app.jobs.enqueue(ctx.tenantId, 'pass.overstay', { passId, sessionId, amount, currency }));
}

/* ---------------------------------------------------------------------------------------------- */
/* Notifications                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

type Kind = 'checked_in' | 'checked_out' | 'reminder_1' | 'reminder_2' | 'overstay';

/** Record that a notification is owed. Returns false when this kind was already handled (once per pass and kind). */
export async function recordNotification(db: Db, tenantId: string, passId: string, kind: Kind) {
  const r = await db.query(
    `insert into pass_notification (tenant_id, pass_id, kind) values ($1,$2,$3)
     on conflict (pass_id, kind) do update set status = 'pending', created_at = now()
       where pass_notification.status = 'failed' or (pass_notification.status = 'pending' and pass_notification.created_at < now() - interval '10 minutes')
     returning id`, [tenantId, passId, kind]);
  return (r.rowCount ?? 0) > 0;
}

/** Request path: record now, send after the transaction commits. */
export async function queueNotification(app: App, db: Db, ctx: { tenantId: string }, after: After, passId: string, kind: Kind) {
  if (!(await recordNotification(db, ctx.tenantId, passId, kind))) return false;
  after(() => app.background(sendPassNotification(app, ctx.tenantId, passId, kind)));
  return true;
}

const fmtDuration = (ms: number) => `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}min`;

interface Party { recipient: Recipient; locale: string; message: MessageKey }

/** Send one notification kind for one pass to everyone it concerns, and record the outcome. */
export async function sendPassNotification(app: App, tenantId: string, passId: string, kind: Kind) {
  const ctxInfo = await app.db.withTenant(tenantId, async (db) => {
    const row = (await db.query(
      `select p.*, u.code as unit_code, u.name as unit_name, s.code as site_code, h.email as host_email, h.phone as host_phone, h.locale as host_locale
       from pass p join unit u on u.id = p.unit_id join site s on s.id = p.site_id join app_user h on h.id = p.host_user_id where p.id = $1`, [passId])).rows[0];
    const session = row?.session_id ? (await db.query(
      `select s.in_at, s.out_at, v.plate_display, st.timezone from session s join vehicle v on v.id = s.vehicle_id join site st on st.id = s.site_id where s.id = $1`, [row.session_id])).rows[0] : null;
    const staff = (await db.query(
      `select u.email, u.phone from membership m join app_user u on u.id = m.user_id where m.role = $1`, ['supervisor'])).rows;
    const fallback = staff.length ? staff : (await db.query(`select u.email, u.phone from membership m join app_user u on u.id = m.user_id where m.role in ('admin','owner')`)).rows;
    const pol = await loadPolicy(db);
    await db.query('update pass_notification set attempts = attempts + 1 where pass_id = $1 and kind = $2', [passId, kind]);
    return { row, session, staff: fallback as Recipient[], ...pol };
  });
  const { row, session, staff, policy, currency, locale } = ctxInfo;
  if (!row) return;

  const parties: Party[] = [];
  const host: Party = { recipient: { email: row.host_email, phone: row.host_phone }, locale: row.host_locale ?? locale, message: 'checked_in' };
  const guest: Party = { recipient: { email: row.guest_email, phone: row.guest_phone }, locale, message: 'reminder' };
  const staffParties: Party[] = staff.map((s) => ({ recipient: s, locale, message: 'overstay_staff' }));
  if (kind === 'checked_in' || kind === 'checked_out') {
    const m: MessageKey = kind;
    if (policy.alertRecipients.includes('host')) parties.push({ ...host, message: m });
    if (policy.alertRecipients.includes('guest')) parties.push({ ...guest, message: m });
    if (policy.alertRecipients.includes('supervisors')) parties.push(...staffParties.map((p) => ({ ...p, message: m })));
  } else if (kind === 'overstay') {
    parties.push({ ...guest, message: 'overstay_guest' }, { ...host, message: 'overstay_host' }, ...staffParties);
  } else {
    parties.push(guest);
  }

  const outcome = { sent: 0, undeliverable: 0, failed: 0, errors: [] as string[] };
  for (const p of parties) {
    const fmt = (d: Date) => new Intl.DateTimeFormat(p.locale, { timeStyle: 'short', timeZone: session?.timezone ?? 'UTC' }).format(d);
    const charge = row.overstay_charge ?? policy.overstayCharge;
    const stayMs = session ? (session.out_at ?? app.now()).getTime() - session.in_at.getTime() : 0;
    const msg = render(p.locale, p.message, {
      guest: row.guest_name, unit: row.unit_name, site: row.site_code, plate: session?.plate_display ?? row.plate_hint ?? '—',
      time: session ? fmt(kind === 'checked_out' && session.out_at ? session.out_at : session.in_at) : '',
      duration: fmtDuration(stayMs), limit: String(policy.maxStayHours),
      hours: String(kind === 'reminder_2' ? policy.reminderHours[1] : policy.reminderHours[0]),
      amount: new Intl.NumberFormat(p.locale, { style: 'currency', currency }).format(charge / 100),
    });
    try {
      const d = await app.notifier.send({ to: p.recipient, ...msg });
      if (d.length) outcome.sent++; else outcome.undeliverable++;
    } catch (e) {
      outcome.failed++; outcome.errors.push((e as Error).message);
    }
  }
  // Retry only when every attempt failed; a partial success is not repeated (it would double-message the others).
  const status = outcome.sent ? 'sent' : outcome.failed ? 'failed' : 'skipped';
  await app.db.withTenant(tenantId, (db) => db.query(
    `update pass_notification set status = $3, sent_at = case when $3 = 'sent' then now() end, detail = $4 where pass_id = $1 and kind = $2`,
    [passId, kind, status, JSON.stringify(outcome)]));
}

/**
 * Cron entry: send the reminder (10h, 11h) or overstay (12h) notices that are due. Only the latest due notice is
 * sent for a pass, so a late run never floods a guest with stale reminders. Safe to run repeatedly.
 */
export async function processPassReminders(app: App, opts: { tenantId?: string } = {}) {
  const now = app.now();
  const all = (await app.db.raw((db) => db.query('select * from due_pass_reminders($1)', [now]))).rows as { tenant_id: string; pass_id: string; kind: Kind }[];
  const due = opts.tenantId ? all.filter((d) => d.tenant_id === opts.tenantId) : all;
  const byPass = new Map<string, { tenant: string; kinds: Kind[] }>();
  for (const d of due) byPass.set(d.pass_id, { tenant: d.tenant_id, kinds: [...(byPass.get(d.pass_id)?.kinds ?? []), d.kind] });
  const order: Kind[] = ['reminder_1', 'reminder_2', 'overstay'];
  const result = { passes: byPass.size, sent: 0 };

  for (const [passId, { tenant, kinds }] of byPass) {
    const latest = order.filter((k) => kinds.includes(k)).pop()!;
    const hooks: (() => void | Promise<void>)[] = [];
    const owed = await app.db.withTenant(tenant, async (db) => {
      for (const k of kinds.filter((x) => x !== latest)) {
        await db.query("insert into pass_notification (tenant_id, pass_id, kind, status) values ($1,$2,$3,'skipped') on conflict (pass_id, kind) do nothing", [tenant, passId, k]);
      }
      if (latest === 'overstay') {
        const p = (await db.query('select session_id, overstay_charge from pass where id = $1', [passId])).rows[0];
        if (p.overstay_charge === null) {
          const { policy } = await loadPolicy(db);
          await db.query('update pass set overstay_charge = $2 where id = $1', [passId, policy.overstayCharge]);
          await recordOverstay(app, db, { tenantId: tenant } as Ctx, (fn) => { hooks.push(fn); }, passId, p.session_id, policy.overstayCharge);
        }
      }
      return recordNotification(db, tenant, passId, latest);
    });
    // Everything below runs after the bookkeeping transaction has committed, and is awaited so a serverless
    // function is not frozen mid-send.
    for (const h of hooks) await h();
    if (owed) { await sendPassNotification(app, tenant, passId, latest); result.sent++; }
  }
  return result;
}
