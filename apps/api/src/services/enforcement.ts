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

async function storeEvidence(app: App, db: Db, ctx: Ctx, found: Inspection, evidenceId: string, data: string) {
  const asset = await imageAsset(db, ctx.tenantId, {
    type: found.action === 'fine' ? 'violation' : 'immobilization',
    subject: found.plate ?? evidenceId,
    subjectKind: found.plate ? 'plate' : 'text',
    region: found.region,
    event: evidenceId,
    departmentNumber: found.unit?.code ?? null,
  }, Buffer.from(data, 'base64'));
  if (!asset) throw new HttpError(500, 'evidence_failed', 'The evidence could not be stored');
  return imageStorageKey(ctx.tenantId, asset.key);
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
  const now = app.now();
  let evidenceKey: string | null = null;
  let evidenceId: string | null = null;
  if (input.evidence) {
    evidenceId = randomUUID();
    evidenceKey = await storeEvidence(app, db, ctx, found, evidenceId, input.evidence.dataBase64);
  }

  const site = await resolveSite(db, ctx, input.site);
  await db.query(
    `insert into enforcement_case (id, tenant_id, site_id, session_id, vehicle_id, plate_display, plate_region,
      reasons, action, unit_id, amount_minor, currency, evidence_key, actor_id, created_at, fine_issued_at, immobilized_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [id, ctx.tenantId, site.id, found.sessionId, found.vehicleId,
      found.plate, found.region, found.reasons, found.action, found.unit?.id ?? null,
      found.action === 'fine' ? FINE_MINOR : null, found.action === 'fine' ? 'MXN' : null, evidenceKey, ctx.userId, now,
      null, found.action === 'immobilization' ? now : null]);
  if (evidenceId && evidenceKey) {
    await db.query('insert into enforcement_evidence (id, tenant_id, case_id, image_key, actor_id, created_at) values ($1,$2,$3,$4,$5,$6)',
      [evidenceId, ctx.tenantId, id, evidenceKey, ctx.userId, now]);
  }

  return { id, ...found, evidenceUrl: evidenceKey ? signUrl(app.cfg.JWT_SECRET, evidenceKey, 300) : null };
}

const REPORT_SQL = `select c.id, c.site_id, c.session_id, c.vehicle_id, c.plate_display, c.plate_region, c.reasons, c.action,
  c.unit_id, c.amount_minor, c.currency, c.evidence_key, c.actor_id, c.created_at, c.fine_issued_at, c.immobilized_at,
  st.code as site_code, u.code as unit_code, u.name as unit_name
  from enforcement_case c join site st on st.id = c.site_id left join unit u on u.id = c.unit_id`;

function requiredActions(row: { unit_id: string | null; fine_issued_at: Date | null; immobilized_at: Date | null }) {
  const required: string[] = [];
  if (row.unit_id && !row.fine_issued_at) required.push('fine');
  if (!row.immobilized_at) required.push('immobilization');
  return required;
}

async function presentReport(app: App, db: Db, row: any) {
  const required = requiredActions(row);
  const photos = (await db.query('select id, image_key, created_at from enforcement_evidence where case_id = $1 order by created_at, id', [row.id])).rows;
  return {
    id: row.id, site: row.site_code, sessionId: row.session_id, vehicleId: row.vehicle_id,
    plate: row.plate_display, region: row.plate_region, reasons: row.reasons, action: row.action,
    unit: row.unit_id ? { id: row.unit_id, code: row.unit_code, name: row.unit_name } : null,
    fine: row.amount_minor == null ? null : { amountMinor: row.amount_minor, currency: row.currency },
    createdAt: row.created_at, fineIssuedAt: row.fine_issued_at, immobilizedAt: row.immobilized_at,
    requiredActions: required, status: required.length ? 'open' : 'complete',
    evidence: photos.map((p) => ({ id: p.id, url: signUrl(app.cfg.JWT_SECRET, p.image_key, 300), createdAt: p.created_at })),
  };
}

async function reportById(app: App, db: Db, id: string) {
  const row = (await db.query(`${REPORT_SQL} where c.id = $1`, [id])).rows[0];
  if (!row) throw new HttpError(404, 'report_not_found', 'No such enforcement report');
  return presentReport(app, db, row);
}

export async function listReports(app: App, db: Db, ctx: Ctx, input: { site?: string; status: 'open' | 'all'; limit: number }) {
  const where: string[] = []; const args: unknown[] = [];
  const add = (sql: string, value: unknown) => { args.push(value); where.push(sql.replace('?', `$${args.length}`)); };
  if (input.site) add('c.site_id = ?', (await resolveSite(db, ctx, input.site)).id);
  else if (ctx.siteId) add('c.site_id = ?', ctx.siteId);
  if (input.status === 'open') where.push(`((c.unit_id is not null and (c.fine_issued_at is null or c.immobilized_at is null)) or (c.unit_id is null and c.immobilized_at is null))`);
  args.push(input.limit);
  const rows = (await db.query(`${REPORT_SQL}${where.length ? ` where ${where.join(' and ')}` : ''} order by c.created_at desc, c.id limit $${args.length}`, args)).rows;
  const reports = [];
  for (const row of rows) reports.push(await presentReport(app, db, row));
  return { items: reports };
}

export async function issueFine(app: App, db: Db, ctx: Ctx, id: string) {
  const row = (await db.query('select id, action, unit_id, fine_issued_at from enforcement_case where id = $1 for update', [id])).rows[0];
  if (!row) throw new HttpError(404, 'report_not_found', 'No such enforcement report');
  if (row.action !== 'fine' || !row.unit_id) throw new HttpError(409, 'fine_not_available', 'This report has no responsible unit to fine');
  if (!row.fine_issued_at) await db.query('update enforcement_case set fine_issued_at = $2 where id = $1', [id, app.now()]);
  return reportById(app, db, id);
}

export async function appendReportEvidence(app: App, db: Db, ctx: Ctx, id: string, input: { dataBase64: string; immobilize: boolean }) {
  const row = (await db.query(`${REPORT_SQL} where c.id = $1 for update of c`, [id])).rows[0];
  if (!row) throw new HttpError(404, 'report_not_found', 'No such enforcement report');
  if (input.immobilize && row.immobilized_at) throw new HttpError(409, 'already_immobilized', 'This vehicle is already immobilized');
  const evidenceId = randomUUID();
  const found = {
    action: row.action, plate: row.plate_display, region: row.plate_region,
    unit: row.unit_id ? { id: row.unit_id, code: row.unit_code, name: row.unit_name } : null,
  } as Inspection;
  const key = await storeEvidence(app, db, ctx, found, evidenceId, input.dataBase64);
  const now = app.now();
  await db.query('insert into enforcement_evidence (id, tenant_id, case_id, image_key, actor_id, created_at) values ($1,$2,$3,$4,$5,$6)',
    [evidenceId, ctx.tenantId, id, key, ctx.userId, now]);
  await db.query('update enforcement_case set evidence_key = $2, immobilized_at = case when $3 then coalesce(immobilized_at, $4) else immobilized_at end where id = $1',
    [id, key, input.immobilize, now]);
  return reportById(app, db, id);
}
