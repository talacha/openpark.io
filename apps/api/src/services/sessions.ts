import { RateRules, computeFee, displayPlate, matchPlateClass, normalizePlate, plateDistance, type FeeResult } from '@openpark/core';
import { can, newTicketCode } from '../auth.js';
import { emit, type Db } from '../db.js';
import { HttpError, type Ctx } from '../http.js';
import type { WebhookEvent } from '../jobs.js';
import type { App } from '../server.js';
import { completePass, passFee } from './passes.js';

type After = (fn: () => void | Promise<void>) => void;

export interface CheckInInput {
  site: string;
  plate: { display: string; region?: string };
  vehicle?: { bodyType?: string; make?: string; model?: string; color?: string; year?: number };
  slot?: string;
  source: 'manual' | 'ai_assist' | 'ai_auto';
  read?: { textRaw?: string; confidence?: number; engine?: string; latencyMs?: number; cropKey?: string };
  /** Who authorized a walk-in's access: a community unit or an ad-hoc "Other" person. Never set for a pass redemption. */
  authorizedBy?: { unit: string } | { name: string; phone: string };
  deviceId?: string;
  gate?: string;
  deviceAt?: string;
}

export interface CheckOutInput {
  lostTicket?: boolean;
  override?: { fee: number; reason: string };
  payment?: { method: 'cash' | 'card' | 'account'; amount: number; receiptNo?: string };
  deviceId?: string;
  gate?: string;
  deviceAt?: string;
}

const CLOCK_GAP_SEC = 300;

export async function resolveSite(db: Db, ctx: Ctx, code: string) {
  const r = await db.query('select id, code, timezone, default_rate_plan_id, settings from site where code = $1 and retired_at is null', [code]);
  const site = r.rows[0];
  if (!site || (ctx.siteId && ctx.siteId !== site.id)) throw new HttpError(404, 'site_not_found', `No site ${code}`);
  return site as { id: string; code: string; timezone: string; default_rate_plan_id: string | null; settings: { aiThreshold?: number } };
}

export async function addEvent(db: Db, ctx: Ctx, sessionId: string, type: string, payload: unknown, extra: { deviceId?: string; gate?: string; deviceAt?: string; at?: Date } = {}) {
  // Stamp server_at from the authoritative app clock (app.now()) when the caller passes it, so audit/report
  // timestamps match session.in_at/out_at and day-bucketed reports stay consistent; falls back to DB now().
  await db.query(
    'insert into session_event (tenant_id, session_id, type, actor_id, device_id, gate, device_at, server_at, payload) values ($1,$2,$3,$4,$5,$6,$7,coalesce($8, now()),$9)',
    [ctx.tenantId, sessionId, type, ctx.userId, extra.deviceId ?? null, extra.gate ?? null, extra.deviceAt ?? null, extra.at ?? null, JSON.stringify(payload)]);
}

/** Free slot for a body type: preferred type first, then ordinary types; never EV/accessible/assigned. */
export async function suggestSlot(db: Db, siteId: string, bodyType?: string | null) {
  const order = bodyType === 'motorcycle' ? ['moto', 'standard', 'compact'] : ['standard', 'compact', 'oversize'];
  for (const type of order) {
    const r = await db.query(
      `select sl.id, sl.code, sl.type, z.code as zone from slot sl join zone z on z.id = sl.zone_id
       where sl.site_id = $1 and sl.status = 'available' and sl.retired_at is null and sl.type = $2
         and (sl.assignment is null or sl.assignment->>'permit' is null)
       order by z.sort, sl.code limit 1`, [siteId, type]);
    if (r.rows[0]) return r.rows[0] as { id: string; code: string; type: string; zone: string };
  }
  return null;
}

async function freeCounts(db: Db, siteId: string) {
  return (await db.query(
    `select z.code as zone, sl.type, count(*)::int as free from slot sl join zone z on z.id = sl.zone_id
     where sl.site_id = $1 and sl.status = 'available' and sl.retired_at is null group by 1, 2 order by 1, 2`, [siteId])).rows;
}

function queueWebhook(app: App, after: After, tenantId: string, event: WebhookEvent, payload: unknown) {
  after(() => app.jobs.enqueue(tenantId, event, payload));
}

export async function checkIn(app: App, db: Db, ctx: Ctx, after: After, input: CheckInInput, opts: { pass?: { id: string; guestName: string } } = {}) {
  const site = await resolveSite(db, ctx, input.site);
  // A guest pass is free within its stay limit, so it needs no rate plan.
  if (!site.default_rate_plan_id && !opts.pass) throw new HttpError(409, 'no_rate_plan', 'Site has no default rate plan');
  const tenant = (await db.query('select plate_regions from tenant')).rows[0];
  const region = input.plate.region ?? tenant.plate_regions[0] ?? 'XX';
  const display = displayPlate(input.plate.display);
  const norm = normalizePlate(display);
  if (!norm) throw new HttpError(400, 'empty_plate', 'Plate is empty');

  const reg = app.plates.get(region);
  const plateClass = reg ? matchPlateClass(reg, norm) : null;
  const warnings: string[] = [];
  if (reg && !plateClass) warnings.push('plate_format_mismatch');

  const now = app.now();
  if (input.deviceAt && Math.abs(new Date(input.deviceAt).getTime() - now.getTime()) / 1000 > CLOCK_GAP_SEC) warnings.push('device_clock_gap');

  const v = input.vehicle ?? {};
  const veh = (await db.query(
    `insert into vehicle (tenant_id, plate_display, plate_norm, plate_region, plate_class, body_type, make, model, color, year)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (tenant_id, plate_region, plate_norm) do update set plate_display = excluded.plate_display,
       plate_class = coalesce(excluded.plate_class, vehicle.plate_class),
       body_type = coalesce(excluded.body_type, vehicle.body_type), make = coalesce(excluded.make, vehicle.make),
       model = coalesce(excluded.model, vehicle.model), color = coalesce(excluded.color, vehicle.color), year = coalesce(excluded.year, vehicle.year)
     returning id, body_type`,
    [ctx.tenantId, display, norm, region, plateClass, v.bodyType ?? null, v.make ?? null, v.model ?? null, v.color ?? null, v.year ?? null])).rows[0];

  const open = (await db.query(
    `select s.id, s.in_at, sl.code as slot from session s left join slot sl on sl.id = s.slot_id
     where s.site_id = $1 and s.vehicle_id = $2 and s.status = 'open'`, [site.id, veh.id])).rows[0];
  if (open) throw new HttpError(409, 'already_inside', `Inside since ${open.in_at.toISOString()}${open.slot ? ` at ${open.slot}` : ''}`,
    { sessionId: open.id, inAt: open.in_at, slot: open.slot });

  // Pick the slot: explicit, else the permit's assigned slot, else best free slot by rule.
  const permitSlot = (await db.query(
    `select sl.id, sl.code from permit p join slot sl on sl.id = p.slot_id
     where $1 = any(p.vehicle_ids) and p.valid_from <= $2 and (p.valid_to is null or p.valid_to > $2) limit 1`, [veh.id, now])).rows[0];
  let slot: { id: string; code: string }; let reason: 'explicit' | 'permit' | 'auto';
  if (input.slot) {
    const r = await db.query('select id, code from slot where site_id = $1 and code = $2 and retired_at is null', [site.id, input.slot]);
    if (!r.rows[0]) throw new HttpError(404, 'slot_not_found', `No slot ${input.slot}`);
    slot = r.rows[0]; reason = 'explicit';
  } else if (permitSlot) { slot = permitSlot; reason = 'permit'; }
  else {
    const s = await suggestSlot(db, site.id, veh.body_type);
    if (!s) throw new HttpError(409, 'site_full', 'No free slot', { free: await freeCounts(db, site.id) });
    slot = s; reason = 'auto';
  }

  const claimed = await db.query("update slot set status = 'occupied' where id = $1 and status = 'available' and retired_at is null returning id", [slot.id]);
  if (!claimed.rowCount) {
    const offender = (await db.query(
      `select v.plate_display from session s join vehicle v on v.id = s.vehicle_id where s.slot_id = $1 and s.status = 'open'`, [slot.id])).rows[0];
    const suggestion = await suggestSlot(db, site.id, veh.body_type);
    throw new HttpError(409, reason === 'permit' ? 'assigned_slot_taken' : 'slot_unavailable',
      reason === 'permit' ? 'Assigned slot is taken by another car' : `Slot ${slot.code} is not available`,
      { slot: slot.code, offender: offender?.plate_display ?? null, suggestion: suggestion?.code ?? null });
  }

  let sess: { id: string; ticket_code: string } | undefined;
  for (let i = 0; i < 5 && !sess; i++) {
    try {
      sess = (await db.query(
        `insert into session (tenant_id, site_id, vehicle_id, slot_id, ticket_code, in_at, in_by, rate_plan_id, authorized_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) on conflict (tenant_id, ticket_code) do nothing returning id, ticket_code`,
        [ctx.tenantId, site.id, veh.id, slot.id, newTicketCode(), now, ctx.userId, opts.pass ? null : site.default_rate_plan_id,
          input.authorizedBy ? JSON.stringify(input.authorizedBy) : null])).rows[0];
    } catch (e) {
      if ((e as { constraint?: string }).constraint === 'session_one_open_per_vehicle') throw new HttpError(409, 'already_inside', 'Vehicle is already inside');
      throw e;
    }
  }
  if (!sess) throw new HttpError(500, 'ticket_collision', 'Could not allocate a ticket code');

  if (input.read) {
    await db.query(
      `insert into plate_read (tenant_id, session_id, device_id, crop_key, text_raw, text_norm, region, confidence, engine, latency_ms, corrected_to, decided_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [ctx.tenantId, sess.id, input.deviceId ?? null, input.read.cropKey ?? null, input.read.textRaw ?? null,
        input.read.textRaw ? normalizePlate(input.read.textRaw) : null, region, input.read.confidence ?? null, input.read.engine ?? null,
        input.read.latencyMs ?? null, input.read.textRaw && normalizePlate(input.read.textRaw) !== norm ? norm : null, ctx.userId]);
  }
  const extra = { deviceId: input.deviceId, gate: input.gate, deviceAt: input.deviceAt, at: now };
  await addEvent(db, ctx, sess.id, 'check_in', { plate: display, region, source: input.source, confidence: input.read?.confidence ?? null, ...(opts.pass ? { passId: opts.pass.id } : {}), ...(input.authorizedBy ? { authorizedBy: input.authorizedBy } : {}) }, extra);
  await addEvent(db, ctx, sess.id, 'slot_assigned', { slot: slot.code, reason }, extra);

  const out = {
    session: { id: sess.id, ticketCode: sess.ticket_code, inAt: now.toISOString(), site: site.code },
    slot: slot.code, vehicle: { id: veh.id, plate: display, region, plateClass }, warnings,
  };
  await emit(db, ctx.tenantId, 'session.opened', out);
  await emit(db, ctx.tenantId, 'slot.changed', { site: site.code, slot: slot.code, status: 'occupied' });
  queueWebhook(app, after, ctx.tenantId, 'session.opened', out);
  queueWebhook(app, after, ctx.tenantId, 'slot.changed', { site: site.code, slot: slot.code, status: 'occupied' });
  return out;
}

export interface OpenSession {
  id: string; site_id: string; site_code: string; timezone: string; ticket_code: string; in_at: Date; in_by: string | null; in_by_name: string | null;
  slot_id: string | null; slot: string | null; rate_plan_id: string | null; pass_id: string | null; plate_display: string; plate_norm: string; plate_region: string;
  make: string | null; model: string | null; color: string | null;
}

const OPEN_SQL = `select s.id, s.site_id, st.code as site_code, st.timezone, s.ticket_code, s.in_at, s.in_by, u.name as in_by_name, s.slot_id, sl.code as slot,
    s.rate_plan_id, p.id as pass_id, v.plate_display, v.plate_norm, v.plate_region, v.make, v.model, v.color
  from session s join site st on st.id = s.site_id join vehicle v on v.id = s.vehicle_id
  left join slot sl on sl.id = s.slot_id left join app_user u on u.id = s.in_by left join pass p on p.session_id = s.id
  where s.status = 'open'`;

export async function getOpenById(db: Db, id: string): Promise<OpenSession> {
  const r = (await db.query(`${OPEN_SQL} and s.id = $1`, [id])).rows[0];
  if (!r) {
    const any = (await db.query('select status from session where id = $1', [id])).rows[0];
    throw any ? new HttpError(409, 'not_open', `Session is ${any.status}`) : new HttpError(404, 'session_not_found', 'No such session');
  }
  return r;
}

/** Exact plate_norm, then ticket code; fuzzy candidates (distance <= 1) are returned, never auto-matched. */
export async function matchOpen(app: App, db: Db, ctx: Ctx, input: { site: string; plate?: string; region?: string; ticket?: string }) {
  const site = await resolveSite(db, ctx, input.site);
  if (input.ticket) {
    const r = (await db.query(`${OPEN_SQL} and s.site_id = $1 and s.ticket_code = $2`, [site.id, input.ticket.toUpperCase()])).rows[0];
    if (r) return { session: r as OpenSession, method: 'ticket' as const, candidates: [] };
  }
  if (input.plate) {
    const norm = normalizePlate(input.plate);
    const open = (await db.query(`${OPEN_SQL} and s.site_id = $1`, [site.id])).rows as OpenSession[];
    const exact = open.find((s) => s.plate_norm === norm);
    if (exact) return { session: exact, method: 'plate' as const, candidates: [] };
    const conf = app.plates.get(input.region ?? '')?.confusables ?? [];
    const candidates = open.map((s) => ({ s, d: plateDistance(norm, s.plate_norm, conf) })).filter((x) => x.d <= 1).sort((a, b) => a.d - b.d).slice(0, 5)
      .map((x) => ({ sessionId: x.s.id, ticketCode: x.s.ticket_code, plate: x.s.plate_display, slot: x.s.slot, inAt: x.s.in_at, distance: x.d }));
    return { session: null, method: null, candidates };
  }
  return { session: null, method: null, candidates: [] };
}

type Quote = FeeResult & { hoaCharge?: number; maxStayHours?: number };

async function quote(db: Db, s: OpenSession, now: Date, lostTicket?: boolean): Promise<Quote> {
  if (s.pass_id || !s.rate_plan_id) return passFee(db, s, now);
  const plan = (await db.query('select rules from rate_plan where id = $1', [s.rate_plan_id])).rows[0];
  return computeFee(RateRules.parse(plan.rules), s.in_at, now, { lostTicket });
}

/** Everything the attendant reviews before confirming. */
export async function checkoutPreview(app: App, db: Db, s: OpenSession, lostTicket?: boolean) {
  const now = app.now();
  const fee = await quote(db, s, now, lostTicket);
  return {
    session: { id: s.id, ticketCode: s.ticket_code, site: s.site_code, inAt: s.in_at, inBy: s.in_by_name, outAt: now.toISOString() },
    vehicle: { plate: s.plate_display, make: s.make, model: s.model, color: s.color }, slot: s.slot, fee,
  };
}

export async function checkOut(app: App, db: Db, ctx: Ctx, after: After, s: OpenSession, method: 'plate' | 'ticket' | 'fuzzy' | 'session', input: CheckOutInput) {
  if (ctx.siteId && ctx.siteId !== s.site_id) throw new HttpError(404, 'session_not_found', 'No such session');
  if ((input.lostTicket || input.override) && !can(ctx, 'fee.override')) throw new HttpError(403, 'forbidden', 'Lost-ticket and fee overrides need the supervisor role');
  const now = app.now();
  const fee = await quote(db, s, now, input.lostTicket);
  const final = input.override ? input.override.fee : fee.total;

  const closed = await db.query(
    `update session set status = 'closed', out_at = $2, out_by = $3, fee = $4, fee_breakdown = $5 where id = $1 and status = 'open' returning id`,
    [s.id, now, ctx.userId, final, JSON.stringify(fee)]);
  if (!closed.rowCount) throw new HttpError(409, 'not_open', 'Session was already closed');
  if (s.slot_id) await db.query("update slot set status = 'available' where id = $1 and status = 'occupied'", [s.slot_id]);
  const pass = s.pass_id ? await completePass(app, db, ctx, after, { id: s.id, pass_id: s.pass_id, in_at: s.in_at }, now) : null;

  const extra = { deviceId: input.deviceId, gate: input.gate, deviceAt: input.deviceAt, at: now };
  await addEvent(db, ctx, s.id, 'check_out', { matchMethod: method, minutes: fee.minutes, fee: final, lostTicket: !!input.lostTicket, ...(s.pass_id ? { passId: s.pass_id } : {}) }, extra);
  if (input.override) await addEvent(db, ctx, s.id, 'fee_override', { original: fee.total, override: input.override.fee, reason: input.override.reason }, { at: now });
  let receipt: string | null = null;
  if (input.payment) receipt = await recordPayment(db, ctx, s.id, s.ticket_code, input.payment, now);

  const out = {
    session: { id: s.id, ticketCode: s.ticket_code, site: s.site_code, inAt: s.in_at, outAt: now.toISOString() },
    vehicle: { plate: s.plate_display }, slot: s.slot, minutes: fee.minutes, fee: { total: final, tax: fee.tax, lines: fee.lines, original: fee.total, ...(pass ? { hoaCharge: pass.over ? pass.charge : 0 } : {}) }, receipt,
  };
  await emit(db, ctx.tenantId, 'session.closed', out);
  if (s.slot) await emit(db, ctx.tenantId, 'slot.changed', { site: s.site_code, slot: s.slot, status: 'available' });
  queueWebhook(app, after, ctx.tenantId, 'session.closed', out);
  if (s.slot) queueWebhook(app, after, ctx.tenantId, 'slot.changed', { site: s.site_code, slot: s.slot, status: 'available' });
  return out;
}

export async function recordPayment(db: Db, ctx: Ctx, sessionId: string, ticket: string, p: NonNullable<CheckOutInput['payment']>, at?: Date) {
  const n = (await db.query("select count(*)::int as n from session_event where session_id = $1 and type = 'payment'", [sessionId])).rows[0].n;
  const receiptNo = p.receiptNo ?? `R-${ticket}-${n + 1}`;
  await addEvent(db, ctx, sessionId, 'payment', { amount: p.amount, method: p.method, receiptNo }, { at });
  return receiptNo;
}
