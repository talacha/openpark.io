import { randomUUID } from 'node:crypto';
import { normalizePlate } from '@openpark/core';
import type { Db } from '../db.js';
import { HttpError, type Ctx } from '../http.js';
import { imageAsset, imageStorageKey } from '../images.js';
import type { App } from '../server.js';
import { signUrl } from '../storage.js';
import { parsePassToken } from './passes.js';
import { resolveSite } from './sessions.js';

export const MAX_STAY_MS = 12 * 60 * 60 * 1000;
export const FINE_MINOR = 500000;

type Reason = 'overstay' | 'not_checked_in' | 'wrong_slot';
type Unit = { id: string; code: string; name: string };
type SessionRow = {
  id: string; vehicle_id: string; ticket_code: string; in_at: Date;
  plate_display: string; plate_region: string; current_slot: string | null;
  unit_id: string | null; unit_code: string | null; unit_name: string | null;
};
export type Inspection = {
  status: 'valid' | 'invalid'; reasons: Reason[];
  plate: string | null; region: string | null; vehicleId: string | null;
  sessionId: string | null; ticketCode: string | null; checkedInAt: Date | null;
  currentSlot: string | null; expectedSlot: string | null;
  unit: Unit | null; fine: { amountMinor: number; currency: 'MXN' } | null;
  action: 'fine' | 'immobilization' | null;
};

const SESSION_SQL = `select s.id, s.vehicle_id, s.ticket_code, s.in_at, v.plate_display, v.plate_region,
  sl.code as current_slot, u.id as unit_id, u.code as unit_code, u.name as unit_name
  from session s join vehicle v on v.id = s.vehicle_id left join slot sl on sl.id = s.slot_id
  left join pass p on p.session_id = s.id and p.status = 'checked_in'
  left join unit u on u.id = p.unit_id or (p.id is null and u.code = s.authorized_by->>'unit')`;

async function openSession(db: Db, siteId: string, where: string, value: string): Promise<SessionRow | null> {
  return (await db.query(`${SESSION_SQL} where s.site_id = $1 and s.status = 'open' and ${where} limit 1`, [siteId, value])).rows[0] ?? null;
}

function unitFrom(row: SessionRow | null): Unit | null {
  return row?.unit_id && row.unit_code && row.unit_name ? { id: row.unit_id, code: row.unit_code, name: row.unit_name } : null;
}

export async function inspectVehicle(app: App, db: Db, ctx: Ctx, siteCode: string, rawEntry: string): Promise<Inspection> {
  const site = await resolveSite(db, ctx, siteCode);
  const entry = rawEntry.trim();
  if (!entry) throw new HttpError(400, 'entry_required', 'Scan or enter a plate, ticket or guest pass');

  let session: SessionRow | null = null;
  let unit: Unit | null = null;
  let plate: string | null = null;
  let region: string | null = null;
  let vehicleId: string | null = null;
  const passPayload = parsePassToken(app.cfg.JWT_SECRET, entry);

  if (passPayload) {
    const p = (await db.query(
      `select p.id, p.session_id, p.qr_version, p.verify_code, p.plate_hint, u.id as unit_id, u.code as unit_code, u.name as unit_name
       from pass p join unit u on u.id = p.unit_id where p.id = $1 and p.site_id = $2`, [passPayload.id, site.id])).rows[0];
    if (!p) throw new HttpError(404, 'pass_not_found', 'No such guest pass at this site');
    if (p.qr_version !== passPayload.version || p.verify_code !== passPayload.code) throw new HttpError(409, 'pass_superseded', 'This QR was replaced by a newer one');
    unit = { id: p.unit_id, code: p.unit_code, name: p.unit_name };
    plate = p.plate_hint;
    if (p.session_id) session = await openSession(db, site.id, 's.id = $2', p.session_id);
  } else {
    const norm = normalizePlate(entry);
    session = await openSession(db, site.id, 's.ticket_code = $2', entry.toUpperCase());
    if (!session) session = await openSession(db, site.id, 'v.plate_norm = $2', norm);
    const vehicle = session ? null : (await db.query('select id, plate_display, plate_region from vehicle where plate_norm = $1 limit 1', [norm])).rows[0];
    vehicleId = session?.vehicle_id ?? vehicle?.id ?? null;
    plate = session?.plate_display ?? vehicle?.plate_display ?? entry;
    region = session?.plate_region ?? vehicle?.plate_region ?? null;
    if (!session) {
      const owners = (await db.query(
        `select distinct u.id, u.code, u.name from pass p join unit u on u.id = p.unit_id
         where p.site_id = $1 and p.status in ('active', 'checked_in') and p.plate_hint is not null
         and upper(regexp_replace(p.plate_hint, '[^A-Za-z0-9]', '', 'g')) = $2`, [site.id, norm])).rows as Unit[];
      if (owners.length === 1) unit = owners[0]!;
    }
  }

  unit = unit ?? unitFrom(session);
  vehicleId = session?.vehicle_id ?? vehicleId;
  plate = session?.plate_display ?? plate;
  region = session?.plate_region ?? region;
  const reasons: Reason[] = [];
  let expectedSlot: string | null = null;
  if (!session) reasons.push('not_checked_in');
  else if (app.now().getTime() - session.in_at.getTime() > MAX_STAY_MS) reasons.push('overstay');
  if (vehicleId) {
    const permit = (await db.query(
      `select sl.code from permit p join slot sl on sl.id = p.slot_id
       where $1 = any(p.vehicle_ids) and sl.site_id = $2 and p.valid_from <= $3 and (p.valid_to is null or p.valid_to > $3)
       order by p.valid_from desc limit 1`, [vehicleId, site.id, app.now()])).rows[0];
    expectedSlot = permit?.code ?? session?.current_slot ?? null;
    if (session && permit && session.current_slot !== expectedSlot) reasons.push('wrong_slot');
  } else expectedSlot = session?.current_slot ?? null;

  const status = reasons.length ? 'invalid' : 'valid';
  return {
    status, reasons, plate, region, vehicleId,
    sessionId: session?.id ?? null, ticketCode: session?.ticket_code ?? null, checkedInAt: session?.in_at ?? null,
    currentSlot: session?.current_slot ?? null, expectedSlot,
    unit, fine: unit ? { amountMinor: FINE_MINOR, currency: 'MXN' } : null,
    action: status === 'invalid' ? (unit ? 'fine' : 'immobilization') : null,
  };
}

export async function flagVehicle(app: App, db: Db, ctx: Ctx, input: {
  site: string; entry: string; action: 'fine' | 'immobilization';
  evidence?: { contentType: 'image/jpeg'; dataBase64: string };
}) {
  const found = await inspectVehicle(app, db, ctx, input.site, input.entry);
  if (found.status !== 'invalid' || !found.action) throw new HttpError(409, 'not_a_violation', 'This vehicle has no violation to flag');
  if (input.action !== found.action) throw new HttpError(409, 'action_required', `This vehicle requires ${found.action}`, { requiredAction: found.action });
  if (input.action === 'immobilization' && !input.evidence) {
    throw new HttpError(400, 'evidence_required', 'Photographic evidence of immobilization is required');
  }

  const id = randomUUID();
  let evidenceKey: string | null = null;
  if (input.evidence) {
    const asset = await imageAsset(db, ctx.tenantId, {
      type: input.action === 'fine' ? 'violation' : 'immobilization',
      subject: found.plate ?? input.entry,
      region: found.region,
      event: found.reasons[0] ?? input.action,
      departmentNumber: found.unit?.code ?? null,
    }, Buffer.from(input.evidence.dataBase64, 'base64'));
    if (!asset) throw new HttpError(500, 'evidence_failed', 'The evidence could not be stored');
    evidenceKey = imageStorageKey(ctx.tenantId, asset.key);
  }

  const site = await resolveSite(db, ctx, input.site);
  // The evidence row and the case share this transaction: a failed insert rolls back both.
  await db.query(
    `insert into enforcement_case (id, tenant_id, site_id, session_id, vehicle_id, plate_display, plate_region,
      reasons, action, unit_id, amount_minor, currency, evidence_key, actor_id, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, ctx.tenantId, site.id, found.sessionId, found.vehicleId,
      found.plate, found.region, found.reasons, found.action, found.unit?.id ?? null,
      found.action === 'fine' ? FINE_MINOR : null, found.action === 'fine' ? 'MXN' : null, evidenceKey, ctx.userId, app.now()]);

  return { id, ...found, evidenceUrl: evidenceKey ? signUrl(app.cfg.JWT_SECRET, evidenceKey, 300) : null };
}
