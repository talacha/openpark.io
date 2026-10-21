import { z } from 'zod';
import { can } from '../auth.js';
import { audit, emit } from '../db.js';
import { HttpError, defineRoute } from '../http.js';
import type { App } from '../server.js';
import { resolveSite, suggestSlot } from '../services/sessions.js';

export function registerSlotRoutes(app: App) {
  defineRoute(app, {
    method: 'GET', path: '/v1/sites', summary: 'Sites with timezone, zones and AI threshold', perm: 'read',
    async handler({ ctx, db }) {
      return (await db.query(
        `select s.code, s.name, s.timezone, s.settings,
           coalesce((select json_agg(json_build_object('code', z.code, 'name', z.name, 'labels', z.labels, 'level', z.level) order by z.sort) from zone z where z.site_id = s.id), '[]') as zones
         from site s where s.retired_at is null and ($1::uuid is null or s.id = $1) order by s.code`, [ctx.siteId])).rows;
    },
  });

  defineRoute(app, {
    method: 'PATCH', path: '/v1/sites/:code', summary: 'Update site settings (AI auto threshold)', perm: 'settings.edit',
    body: z.object({ aiThreshold: z.number().min(0.5).max(1) }),
    async handler({ ctx, db, params, body }) {
      const r = await db.query("update site set settings = settings || jsonb_build_object('aiThreshold', $2::numeric) where code = $1 returning settings",
        [params.code, body.aiThreshold]);
      if (!r.rowCount) throw new HttpError(404, 'site_not_found', `No site ${params.code}`);
      await audit(db, ctx.tenantId, ctx.userId, 'site.update', `site:${params.code}`, null, body);
      return r.rows[0].settings;
    },
  });

  defineRoute(app, {
    method: 'GET', path: '/v1/slots', summary: 'Slot availability', perm: 'read',
    query: z.object({ site: z.string(), status: z.string().optional(), type: z.string().optional(), zone: z.string().optional() }),
    async handler({ ctx, db, query: q }) {
      const site = await resolveSite(db, ctx, q.site);
      return (await db.query(
        `select sl.code, z.code as zone, sl.type, sl.status, sl.attributes, sl.assignment, sl.note,
           v.plate_display as plate, s.ticket_code, s.in_at
         from slot sl join zone z on z.id = sl.zone_id
         left join session s on s.slot_id = sl.id and s.status = 'open' left join vehicle v on v.id = s.vehicle_id
         where sl.site_id = $1 and sl.retired_at is null
           and ($2::text is null or sl.status = $2) and ($3::text is null or sl.type = $3) and ($4::text is null or z.code = $4)
         order by z.sort, sl.code`, [site.id, q.status ?? null, q.type ?? null, q.zone ?? null])).rows;
    },
  });

  defineRoute(app, {
    method: 'GET', path: '/v1/slots/suggest', summary: 'Best free slot for a body type', perm: 'read',
    query: z.object({ site: z.string(), bodyType: z.string().optional() }),
    async handler({ ctx, db, query: q }) {
      const site = await resolveSite(db, ctx, q.site);
      const s = await suggestSlot(db, site.id, q.bodyType);
      return s ? { slot: s.code, zone: s.zone, type: s.type } : { slot: null };
    },
  });

  defineRoute(app, {
    method: 'GET', path: '/v1/occupancy', summary: 'Live counts by site, zone and slot type', perm: 'read',
    query: z.object({ site: z.string().optional() }),
    async handler({ ctx, db, query: q }) {
      const rows = (await db.query(
        `select st.code as site, z.code as zone, z.name as zone_name, z.labels as zone_labels, sl.type,
           count(*) filter (where sl.status = 'available')::int as free,
           count(*) filter (where sl.status = 'occupied')::int as occupied,
           count(*) filter (where sl.status = 'reserved')::int as reserved,
           count(*) filter (where sl.status = 'out_of_service')::int as out_of_service
         from slot sl join zone z on z.id = sl.zone_id join site st on st.id = sl.site_id
         where sl.retired_at is null and ($1::text is null or st.code = $1) and ($2::uuid is null or st.id = $2)
         group by 1, 2, 3, 4, 5, z.sort order by st.code, z.sort, sl.type`, [q.site ?? null, ctx.siteId])).rows;
      const sum = (k: 'free' | 'occupied' | 'reserved' | 'out_of_service') => rows.reduce((a, r) => a + r[k], 0);
      const today = (await db.query(
        `select coalesce(sum(fee), 0)::int as fees, count(*)::int as closed from session
         where status = 'closed' and out_at >= now() - interval '24 hours'`)).rows[0];
      return { totals: { free: sum('free'), occupied: sum('occupied'), reserved: sum('reserved'), outOfService: sum('out_of_service') }, last24h: today, breakdown: rows };
    },
  });

  defineRoute(app, {
    method: 'PATCH', path: '/v1/slots/:code', summary: 'Status change, e.g. out of service', perm: 'slot.status',
    query: z.object({ site: z.string() }),
    body: z.object({
      status: z.enum(['available', 'out_of_service', 'reserved']).optional(),
      note: z.string().optional(),
      type: z.string().optional(),
      attributes: z.record(z.unknown()).optional(),
    }),
    async handler({ ctx, db, params, query: q, body }) {
      if ((body.type || body.attributes) && !can(ctx, 'inventory.edit')) throw new HttpError(403, 'forbidden', 'Editing slot type needs inventory.edit');
      const site = await resolveSite(db, ctx, q.site);
      const cur = (await db.query('select id, status, type, attributes, note from slot where site_id = $1 and code = $2 and retired_at is null for update', [site.id, params.code])).rows[0];
      if (!cur) throw new HttpError(404, 'slot_not_found', `No slot ${params.code}`);
      if (cur.status === 'occupied' && body.status) throw new HttpError(409, 'slot_occupied', 'Occupied slots change status by check-out');
      await db.query(
        'update slot set status = coalesce($2, status), note = coalesce($3, note), type = coalesce($4, type), attributes = coalesce($5::jsonb, attributes) where id = $1',
        [cur.id, body.status ?? null, body.note ?? null, body.type ?? null, body.attributes ? JSON.stringify(body.attributes) : null]);
      await audit(db, ctx.tenantId, ctx.userId, 'slot.update', `slot:${q.site}/${params.code}`, cur, body);
      const data = { site: q.site, slot: params.code, status: body.status ?? cur.status };
      await emit(db, ctx.tenantId, 'slot.changed', data);
      return { ok: true, ...data };
    },
  });
}
