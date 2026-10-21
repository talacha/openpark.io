import { z } from 'zod';
import { emit } from '../db.js';
import { HttpError, created, defineRoute } from '../http.js';
import type { App } from '../server.js';
import { addEvent, checkIn, checkOut, checkoutPreview, getOpenById, matchOpen, recordPayment } from '../services/sessions.js';

const Plate = z.object({ display: z.string().min(1).max(20), region: z.string().optional() });
const Payment = z.object({ method: z.enum(['cash', 'card', 'account']), amount: z.number().int().min(0), receiptNo: z.string().optional() });
const Device = { deviceId: z.string().uuid().optional(), gate: z.string().optional(), deviceAt: z.string().datetime({ offset: true }).optional() };

const CheckInBody = z.object({
  site: z.string(),
  plate: Plate,
  vehicle: z.object({
    bodyType: z.string().optional(), make: z.string().optional(), model: z.string().optional(),
    color: z.string().optional(), year: z.number().int().optional(),
  }).optional(),
  slot: z.string().optional(),
  source: z.enum(['manual', 'ai_assist', 'ai_auto']).default('manual'),
  read: z.object({
    textRaw: z.string().optional(), confidence: z.number().min(0).max(1).optional(), engine: z.string().optional(),
    latencyMs: z.number().int().optional(), cropKey: z.string().optional(),
  }).optional(),
  ...Device,
});

const CheckOutBody = z.object({
  lostTicket: z.boolean().optional(),
  override: z.object({ fee: z.number().int().min(0), reason: z.string().min(3) }).optional(),
  payment: Payment.optional(),
  ...Device,
});

const MatchBody = z.object({ site: z.string(), plate: z.string().optional(), region: z.string().optional(), ticket: z.string().optional(), lostTicket: z.boolean().optional() })
  .refine((b) => b.plate || b.ticket, { message: 'plate or ticket required' });

export function registerSessionRoutes(app: App) {
  defineRoute(app, {
    method: 'POST', path: '/v1/sessions', summary: 'Check in', perm: 'checkin', body: CheckInBody, idempotent: true,
    handler: async ({ ctx, db, body, after }) => created(await checkIn(app, db, ctx, after, body)),
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/checkout/match', summary: 'Find the open session for a plate or ticket and preview its fee (no writes)', perm: 'checkout', body: MatchBody,
    async handler({ ctx, db, body }) {
      const m = await matchOpen(app, db, ctx, body);
      if (!m.session) return { matched: false, candidates: m.candidates };
      return { matched: true, method: m.method, ...(await checkoutPreview(app, db, m.session, body.lostTicket)) };
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/sessions/:id/checkout', summary: 'Check out a known session; returns fee and breakdown', perm: 'checkout',
    body: CheckOutBody, idempotent: true,
    async handler({ ctx, db, params, body, after }) {
      return checkOut(app, db, ctx, after, await getOpenById(db, params.id!), 'session', body);
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/checkout', summary: 'Check out by plate or ticket code', perm: 'checkout', idempotent: true,
    body: z.object({ site: z.string(), plate: z.string().optional(), region: z.string().optional(), ticket: z.string().optional(),
      /** Set when the attendant picked a fuzzy candidate from /v1/checkout/match. */
      confirmedSession: z.string().uuid().optional() }).merge(CheckOutBody)
      .refine((b) => b.plate || b.ticket || b.confirmedSession, { message: 'plate, ticket or confirmedSession required' }),
    async handler({ ctx, db, body, after }) {
      if (body.confirmedSession) return checkOut(app, db, ctx, after, await getOpenById(db, body.confirmedSession), 'fuzzy', body);
      const m = await matchOpen(app, db, ctx, body);
      if (!m.session) throw new HttpError(404, 'no_open_session', 'No open session matches', { candidates: m.candidates });
      return checkOut(app, db, ctx, after, m.session, m.method!, body);
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/sessions/:id/payments', summary: 'Record a payment against a closed session', perm: 'payment', body: Payment, idempotent: true,
    async handler({ ctx, db, params, body }) {
      const s = (await db.query('select id, status, ticket_code, site_id from session where id = $1', [params.id])).rows[0];
      if (!s || (ctx.siteId && s.site_id !== ctx.siteId)) throw new HttpError(404, 'session_not_found', 'No such session');
      if (s.status !== 'closed') throw new HttpError(409, 'not_closed', 'Payments are recorded on closed sessions');
      return created({ receiptNo: await recordPayment(db, ctx, s.id, s.ticket_code, body) });
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/sessions/:id/void', summary: 'Void a session (supervisor)', perm: 'session.void', body: z.object({ reason: z.string().min(3) }), idempotent: true,
    async handler({ ctx, db, params, body }) {
      const s = (await db.query('select id, status, slot_id, site_id from session where id = $1 for update', [params.id])).rows[0];
      if (!s || (ctx.siteId && s.site_id !== ctx.siteId)) throw new HttpError(404, 'session_not_found', 'No such session');
      if (s.status === 'void') throw new HttpError(409, 'already_void', 'Session is already void');
      await db.query("update session set status = 'void' where id = $1", [s.id]);
      if (s.status === 'open' && s.slot_id) await db.query("update slot set status = 'available' where id = $1 and status = 'occupied'", [s.slot_id]);
      await db.query("update pass set status = 'completed', completed_at = now() where session_id = $1 and status = 'checked_in'", [s.id]);
      await addEvent(db, ctx, s.id, 'void', { reason: body.reason, before: s.status, after: 'void' });
      await emit(db, ctx.tenantId, 'session.voided', { id: s.id });
      return { ok: true };
    },
  });

  defineRoute(app, {
    method: 'GET', path: '/v1/sessions', summary: 'Sessions log', perm: 'read',
    query: z.object({
      site: z.string().optional(), status: z.enum(['open', 'closed', 'void']).optional(),
      from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(),
      attendant: z.string().uuid().optional(), zone: z.string().optional(), plate: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(50), offset: z.coerce.number().int().min(0).default(0),
    }),
    async handler({ ctx, db, query: q }) {
      const where = ['1=1']; const args: unknown[] = [];
      const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replaceAll('?', `$${args.length}`)); };
      if (q.site) add('st.code = ?', q.site);
      if (ctx.siteId) add('s.site_id = ?', ctx.siteId);
      if (q.status) add('s.status = ?', q.status);
      if (q.from) add('s.in_at >= ?', q.from);
      if (q.to) add('s.in_at < ?', q.to);
      if (q.attendant) add('(s.in_by = ? or s.out_by = ?)', q.attendant);
      if (q.zone) add('z.code = ?', q.zone);
      if (q.plate) add('v.plate_norm like ?', `%${q.plate.toUpperCase().replace(/[^A-Z0-9]/g, '')}%`);
      const from = `from session s join site st on st.id = s.site_id join vehicle v on v.id = s.vehicle_id
        left join slot sl on sl.id = s.slot_id left join zone z on z.id = sl.zone_id
        left join app_user ui on ui.id = s.in_by left join app_user uo on uo.id = s.out_by where ${where.join(' and ')}`;
      const total = (await db.query(`select count(*)::int as n ${from}`, args)).rows[0].n;
      const rows = (await db.query(
        `select s.id, s.status, s.ticket_code, st.code as site, v.plate_display as plate, v.make, v.model, v.color, sl.code as slot, z.code as zone,
           s.in_at, s.out_at, extract(epoch from (coalesce(s.out_at, now()) - s.in_at))::int / 60 as minutes, s.fee,
           coalesce(ui.name, ui.email) as in_by, coalesce(uo.name, uo.email) as out_by
         ${from} order by s.in_at desc limit ${q.limit} offset ${q.offset}`, args)).rows;
      return { total, items: rows };
    },
  });

  defineRoute(app, {
    method: 'GET', path: '/v1/sessions/:id/events', summary: "One session's audit timeline", perm: 'read',
    async handler({ ctx, db, params }) {
      const s = (await db.query('select id, site_id from session where id = $1', [params.id])).rows[0];
      if (!s || (ctx.siteId && s.site_id !== ctx.siteId)) throw new HttpError(404, 'session_not_found', 'No such session');
      return (await db.query(
        `select e.id, e.type, e.server_at, e.device_at, e.gate, e.device_id, coalesce(u.name, u.email) as actor, e.payload
         from session_event e left join app_user u on u.id = e.actor_id where e.session_id = $1 order by e.id`, [params.id])).rows;
    },
  });
}
