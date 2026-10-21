import { z } from 'zod';
import { can } from '../auth.js';
import { audit, emit } from '../db.js';
import { HttpError, created, defineRoute, boolQuery } from '../http.js';
import { locateJsonError } from '../jsonpos.js';
import type { App } from '../server.js';
import { resolveSite, suggestSlot } from '../services/sessions.js';
import { applySites, exportSites, parseSitesDoc, previewSites, restoreSites, snapshotSites, type SitesSnapshot } from '../services/sites.js';

function validTimezone(tz: string) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }

export function registerSlotRoutes(app: App) {
  defineRoute(app, {
    method: 'GET', path: '/v1/sites', summary: 'Sites with timezone, address, zones and counts', perm: 'read',
    async handler({ ctx, db }) {
      return (await db.query(
        `select s.code, s.name, s.timezone, s.address, s.settings,
           (select count(*)::int from slot sl where sl.site_id = s.id and sl.retired_at is null) as slots,
           (select count(*)::int from session x where x.site_id = s.id and x.status = 'open') as open_sessions,
           coalesce((select json_agg(json_build_object('code', z.code, 'name', z.name, 'labels', z.labels, 'level', z.level,
             'slots', (select count(*)::int from slot sl where sl.zone_id = z.id and sl.retired_at is null)) order by z.sort, z.code) from zone z where z.site_id = s.id), '[]') as zones
         from site s where s.retired_at is null and ($1::uuid is null or s.id = $1) order by s.code`, [ctx.siteId])).rows;
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/sites', summary: 'Create a site (a parking facility within the property)', perm: 'inventory.edit', replaySafe: true,
    body: z.object({ code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/), name: z.string().min(1).max(100), timezone: z.string().refine(validTimezone, 'Unknown time zone'), address: z.string().max(300).nullable().optional(), aiThreshold: z.number().min(0.5).max(1).optional() }),
    async handler({ ctx, db, body }) {
      if (ctx.siteId) throw new HttpError(403, 'forbidden', 'A key limited to one site cannot create sites');
      // The new site shares the rate plan the property already uses, so check-in works at once; change it under Rates.
      const plan = (await db.query('select default_rate_plan_id from site where default_rate_plan_id is not null and retired_at is null order by code limit 1')).rows[0]?.default_rate_plan_id ?? null;
      const dup = (await db.query('select retired_at from site where code = $1', [body.code])).rows[0];
      if (dup) throw new HttpError(409, 'site_exists', `Site ${body.code} already exists`);
      const r = await db.query('insert into site (tenant_id, code, name, timezone, address, default_rate_plan_id, settings) values ($1,$2,$3,$4,$5,$6,$7) returning id',
        [ctx.tenantId, body.code, body.name, body.timezone, body.address ?? null, plan, JSON.stringify({ aiThreshold: body.aiThreshold ?? 0.95 })]);
      await audit(db, ctx.tenantId, ctx.userId, 'site.create', `site:${body.code}`, null, body);
      return created({ id: r.rows[0].id });
    },
  });

  defineRoute(app, {
    method: 'PATCH', path: '/v1/sites/:code', summary: 'Edit a site: name, time zone, address, AI auto threshold (the code is its identity)', perm: 'settings.edit',
    body: z.object({ name: z.string().min(1).max(100).optional(), timezone: z.string().refine(validTimezone, 'Unknown time zone').optional(), address: z.string().max(300).nullable().optional(), aiThreshold: z.number().min(0.5).max(1).optional() }),
    async handler({ ctx, db, params, body }) {
      const cur = (await db.query('select id, name, timezone, address, settings from site where code = $1 and retired_at is null', [params.code])).rows[0];
      if (!cur || (ctx.siteId && ctx.siteId !== cur.id)) throw new HttpError(404, 'site_not_found', `No site ${params.code}`);
      const settings = body.aiThreshold === undefined ? cur.settings : { ...cur.settings, aiThreshold: body.aiThreshold };
      await db.query('update site set name = $2, timezone = $3, address = $4, settings = $5 where id = $1',
        [cur.id, body.name ?? cur.name, body.timezone ?? cur.timezone, body.address === undefined ? cur.address : body.address, JSON.stringify(settings)]);
      await audit(db, ctx.tenantId, ctx.userId, 'site.update', `site:${params.code}`, cur, body);
      return settings;
    },
  });

  defineRoute(app, {
    method: 'DELETE', path: '/v1/sites/:code', summary: 'Retire a site with no cars inside (history is kept)', perm: 'inventory.edit',
    async handler({ ctx, db, params }) {
      const cur = (await db.query('select id from site where code = $1 and retired_at is null', [params.code])).rows[0];
      if (!cur || ctx.siteId) throw new HttpError(ctx.siteId ? 403 : 404, ctx.siteId ? 'forbidden' : 'site_not_found', ctx.siteId ? 'A key limited to one site cannot retire sites' : `No site ${params.code}`);
      const open = (await db.query("select count(*)::int as n from session where site_id = $1 and status = 'open'", [cur.id])).rows[0].n;
      if (open) throw new HttpError(409, 'site_in_use', 'Cars are still inside this site');
      await db.query('update site set retired_at = now() where id = $1', [cur.id]);
      await db.query('update slot set retired_at = coalesce(retired_at, now()) where site_id = $1', [cur.id]);
      await db.query('update unit set site_id = null where site_id = $1', [cur.id]); // a retired site cannot receive passes
      await audit(db, ctx.tenantId, ctx.userId, 'site.retire', `site:${params.code}`, cur, null);
      return { ok: true };
    },
  });

  // ---- zones: a level or area of a site ------------------------------------------------------------------------------
  defineRoute(app, {
    method: 'POST', path: '/v1/sites/:site/zones', summary: 'Add a zone (level or area) to a site', perm: 'inventory.edit', replaySafe: true,
    body: z.object({ code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/), name: z.string().min(1).max(100), level: z.number().int().min(-20).max(200).nullable().optional(), labels: z.record(z.string().max(100)).optional() }),
    async handler({ ctx, db, params, body }) {
      const site = await resolveSite(db, ctx, params.site!);
      const sort = (await db.query('select coalesce(max(sort), 0) + 1 as n from zone where site_id = $1', [site.id])).rows[0].n;
      const r = await db.query('insert into zone (tenant_id, site_id, code, name, labels, level, sort) values ($1,$2,$3,$4,$5,$6,$7) on conflict (site_id, code) do nothing returning id',
        [ctx.tenantId, site.id, body.code, body.name, JSON.stringify(body.labels ?? {}), body.level ?? null, sort]);
      if (!r.rowCount) throw new HttpError(409, 'zone_exists', `Zone ${body.code} already exists`);
      await audit(db, ctx.tenantId, ctx.userId, 'zone.create', `zone:${site.code}/${body.code}`, null, body);
      return created({ id: r.rows[0].id });
    },
  });

  defineRoute(app, {
    method: 'PATCH', path: '/v1/sites/:site/zones/:code', summary: 'Edit a zone: name, level, translated labels', perm: 'inventory.edit',
    body: z.object({ name: z.string().min(1).max(100).optional(), level: z.number().int().min(-20).max(200).nullable().optional(), labels: z.record(z.string().max(100)).optional() }),
    async handler({ ctx, db, params, body }) {
      const site = await resolveSite(db, ctx, params.site!);
      const cur = (await db.query('select id, name, level, labels from zone where site_id = $1 and code = $2', [site.id, params.code])).rows[0];
      if (!cur) throw new HttpError(404, 'zone_not_found', `No zone ${params.code}`);
      await db.query('update zone set name = $2, level = $3, labels = $4 where id = $1',
        [cur.id, body.name ?? cur.name, body.level === undefined ? cur.level : body.level,
          // Translated labels would keep showing the old name, so renaming without new labels drops them.
          JSON.stringify(body.labels ?? (body.name && body.name !== cur.name ? {} : cur.labels))]);
      await audit(db, ctx.tenantId, ctx.userId, 'zone.update', `zone:${site.code}/${params.code}`, cur, body);
      return { ok: true };
    },
  });

  defineRoute(app, {
    method: 'DELETE', path: '/v1/sites/:site/zones/:code', summary: 'Delete an empty zone (retire or move its slots first)', perm: 'inventory.edit',
    async handler({ ctx, db, params }) {
      const site = await resolveSite(db, ctx, params.site!);
      const cur = (await db.query('select id from zone where site_id = $1 and code = $2', [site.id, params.code])).rows[0];
      if (!cur) throw new HttpError(404, 'zone_not_found', `No zone ${params.code}`);
      const used = (await db.query('select count(*)::int as n from slot where zone_id = $1 and retired_at is null', [cur.id])).rows[0].n;
      if (used) throw new HttpError(409, 'zone_in_use', 'This zone still has slots');
      // Retired slots nobody ever parked in can go; the rest stay as history, which keeps the zone.
      await db.query('delete from slot s where s.zone_id = $1 and not exists (select 1 from session x where x.slot_id = s.id) and not exists (select 1 from permit p where p.slot_id = s.id)', [cur.id]);
      if ((await db.query('select count(*)::int as n from slot where zone_id = $1', [cur.id])).rows[0].n) throw new HttpError(409, 'zone_in_use', 'This zone still has slots or parking history');
      await db.query('delete from zone where id = $1', [cur.id]);
      await audit(db, ctx.tenantId, ctx.userId, 'zone.delete', `zone:${site.code}/${params.code}`, cur, null);
      return { ok: true };
    },
  });

  defineRoute(app, {
    method: 'GET', path: '/v1/slots', summary: 'Slot availability', perm: 'read',
    query: z.object({ site: z.string(), status: z.string().optional(), type: z.string().optional(), zone: z.string().optional() }),
    async handler({ ctx, db, query: q }) {
      const site = await resolveSite(db, ctx, q.site);
      return (await db.query(
        `select sl.code, z.code as zone, z.level as level, sl.type, sl.status, sl.attributes, sl.assignment, sl.note,
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
      // Capacity-bar counts, each reusing the SAME site predicate + args as the breakdown above, so a single-site
      // attendant never sees another site's passes or overstays. issuedPending = active passes not yet checked in
      // (yellow); over10/over12 = open sessions past 10h/12h (subsets of occupied, rendered as overlays).
      const now = app.now();
      const issuedPending = (await db.query(
        `select count(*)::int as n from pass p join site st on st.id = p.site_id
         where p.status = 'active' and p.expires_at > $3
           and ($1::text is null or st.code = $1) and ($2::uuid is null or st.id = $2)`, [q.site ?? null, ctx.siteId, now])).rows[0].n;
      const over10 = (await db.query(
        `select count(*)::int as n from session s join site st on st.id = s.site_id
         where s.status = 'open' and ($1::text is null or st.code = $1) and ($2::uuid is null or st.id = $2)
           and s.in_at < $3::timestamptz - interval '10 hours'`, [q.site ?? null, ctx.siteId, now])).rows[0].n;
      const over12 = (await db.query(
        `select count(*)::int as n from session s join site st on st.id = s.site_id
         where s.status = 'open' and ($1::text is null or st.code = $1) and ($2::uuid is null or st.id = $2)
           and s.in_at < $3::timestamptz - interval '12 hours'`, [q.site ?? null, ctx.siteId, now])).rows[0].n;
      return { totals: { free: sum('free'), occupied: sum('occupied'), reserved: sum('reserved'), outOfService: sum('out_of_service') }, issuedPending, over10, over12, last24h: today, breakdown: rows };
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/slots', summary: 'Add a slot to a zone', perm: 'inventory.edit', replaySafe: true,
    query: z.object({ site: z.string() }),
    body: z.object({ code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$/), zone: z.string(), type: z.string().min(1).max(30), note: z.string().max(300).nullable().optional() }),
    async handler({ ctx, db, query: q, body }) {
      const site = await resolveSite(db, ctx, q.site);
      const zone = (await db.query('select id from zone where site_id = $1 and code = $2', [site.id, body.zone])).rows[0];
      if (!zone) throw new HttpError(404, 'zone_not_found', `No zone ${body.zone}`);
      const types: { code: string }[] = (await db.query('select slot_types from tenant')).rows[0].slot_types ?? [];
      if (types.length && !types.some((t) => t.code === body.type)) throw new HttpError(400, 'slot_type_unknown', `Unknown slot type ${body.type}`);
      const old = (await db.query('select id, retired_at from slot where site_id = $1 and code = $2', [site.id, body.code])).rows[0];
      if (old && !old.retired_at) throw new HttpError(409, 'slot_exists', `Slot ${body.code} already exists`);
      // A retired slot of the same code comes back to life, so past sessions keep pointing at the same row.
      const id = old
        ? (await db.query("update slot set retired_at = null, zone_id = $2, type = $3, note = $4, status = 'available' where id = $1 returning id", [old.id, zone.id, body.type, body.note ?? null])).rows[0].id
        : (await db.query('insert into slot (tenant_id, site_id, zone_id, code, type, note) values ($1,$2,$3,$4,$5,$6) returning id', [ctx.tenantId, site.id, zone.id, body.code, body.type, body.note ?? null])).rows[0].id;
      await audit(db, ctx.tenantId, ctx.userId, 'slot.create', `slot:${q.site}/${body.code}`, null, body);
      await emit(db, ctx.tenantId, 'slot.changed', { site: q.site, slot: body.code, status: 'available' });
      return created({ id });
    },
  });

  defineRoute(app, {
    method: 'DELETE', path: '/v1/slots/:code', summary: 'Retire a slot that has no car in it (history is kept)', perm: 'inventory.edit',
    query: z.object({ site: z.string() }),
    async handler({ ctx, db, params, query: q }) {
      const site = await resolveSite(db, ctx, q.site);
      const cur = (await db.query('select id, status from slot where site_id = $1 and code = $2 and retired_at is null for update', [site.id, params.code])).rows[0];
      if (!cur) throw new HttpError(404, 'slot_not_found', `No slot ${params.code}`);
      if (cur.status === 'occupied') throw new HttpError(409, 'slot_occupied', 'A car is in this slot');
      await db.query('update slot set retired_at = now() where id = $1', [cur.id]);
      await audit(db, ctx.tenantId, ctx.userId, 'slot.retire', `slot:${q.site}/${params.code}`, cur, null);
      await emit(db, ctx.tenantId, 'slot.changed', { site: q.site, slot: params.code, status: 'retired' });
      return { ok: true };
    },
  });

  defineRoute(app, {
    method: 'PATCH', path: '/v1/slots/:code', summary: 'Status change, e.g. out of service', perm: 'slot.status',
    query: z.object({ site: z.string() }),
    body: z.object({
      status: z.enum(['available', 'out_of_service', 'reserved']).optional(),
      note: z.string().max(300).optional(),
      type: z.string().min(1).max(30).optional(),
      zone: z.string().optional(),
      attributes: z.record(z.unknown()).optional(),
    }),
    async handler({ ctx, db, params, query: q, body }) {
      if ((body.type || body.attributes || body.zone) && !can(ctx, 'inventory.edit')) throw new HttpError(403, 'forbidden', 'Editing slot type needs inventory.edit');
      if (body.type) {
        const types: { code: string }[] = (await db.query('select slot_types from tenant')).rows[0].slot_types ?? [];
        if (types.length && !types.some((x) => x.code === body.type)) throw new HttpError(400, 'slot_type_unknown', `Unknown slot type ${body.type}`);
      }
      const site = await resolveSite(db, ctx, q.site);
      const cur = (await db.query('select id, status, type, attributes, note from slot where site_id = $1 and code = $2 and retired_at is null for update', [site.id, params.code])).rows[0];
      if (!cur) throw new HttpError(404, 'slot_not_found', `No slot ${params.code}`);
      if (cur.status === 'occupied' && body.status) throw new HttpError(409, 'slot_occupied', 'Occupied slots change status by check-out');
      let zoneId: string | null = null;
      if (body.zone) {
        zoneId = (await db.query('select id from zone where site_id = $1 and code = $2', [site.id, body.zone])).rows[0]?.id ?? null;
        if (!zoneId) throw new HttpError(404, 'zone_not_found', `No zone ${body.zone}`);
      }
      await db.query(
        'update slot set status = coalesce($2, status), note = coalesce($3, note), type = coalesce($4, type), attributes = coalesce($5::jsonb, attributes), zone_id = coalesce($6, zone_id) where id = $1',
        [cur.id, body.status ?? null, body.note ?? null, body.type ?? null, body.attributes ? JSON.stringify(body.attributes) : null, zoneId]);
      await audit(db, ctx.tenantId, ctx.userId, 'slot.update', `slot:${q.site}/${params.code}`, cur, body);
      const data = { site: q.site, slot: params.code, status: body.status ?? cur.status };
      await emit(db, ctx.tenantId, 'slot.changed', data);
      return { ok: true, ...data };
    },
  });

  // ---- bulk sites (communities' parking facilities): validate -> diff -> preview -> apply -> rollback ----------------
  defineRoute(app, {
    method: 'GET', path: '/v1/sites/export', summary: 'Sites (code, name, timezone, address, notes) as JSON', perm: 'inventory.edit',
    handler: async ({ ctx, db }) => exportSites(db, ctx.tenantSlug, app.now()),
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/sites/import', summary: 'Validate a sites file and preview the changes; returns a job', perm: 'inventory.edit', replaySafe: true,
    query: z.object({ mode: z.enum(['merge', 'replace']).default('merge'), dryRun: boolQuery() }),
    body: z.record(z.unknown()),
    async handler({ ctx, db, query, body }) {
      if (ctx.siteId) throw new HttpError(403, 'forbidden', 'A key limited to one site cannot import sites');
      const doc = parseSitesDoc(body, locateJsonError);
      const diff = await previewSites(db, doc, query.mode);
      const job = (await db.query(
        "insert into inventory_import (tenant_id, kind, mode, doc, diff, created_by) values ($1,'sites',$2,$3,$4,$5) returning id",
        [ctx.tenantId, query.mode, JSON.stringify(doc), JSON.stringify({ ...diff, dryRun: query.dryRun }), ctx.userId])).rows[0];
      const summary = { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, conflicts: diff.conflicts.length };
      return created({ job: job.id, mode: query.mode, dryRun: query.dryRun, summary, diff });
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/sites/import/:job/apply', summary: 'Apply a previewed sites import', perm: 'inventory.edit', idempotent: true,
    async handler({ ctx, db, params }) {
      const job = (await db.query("select * from inventory_import where id = $1 and kind = 'sites' for update", [params.job])).rows[0];
      if (!job) throw new HttpError(404, 'job_not_found', 'No such import job');
      if (job.diff.dryRun) throw new HttpError(409, 'dry_run', 'This job was a dry run; submit the import again without dryRun');
      if (job.status !== 'previewed') throw new HttpError(409, 'not_previewed', `Job is ${job.status}`);
      // Capture dependent state (slots, unit associations, cleared notes) BEFORE applying, so a replace that retires a
      // site + its slots and nulls its units can be undone exactly — exportSites alone cannot carry those facts.
      const snapshot = await snapshotSites(db);
      const applied = await applySites(db, ctx.tenantId, ctx.userId, parseSitesDoc(job.doc, locateJsonError), job.mode);
      await db.query("update inventory_import set status = 'applied', snapshot = $2, applied_at = now() where id = $1", [job.id, JSON.stringify(snapshot)]);
      return { job: job.id, applied };
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/sites/import/:job/rollback', summary: 'Restore the exact pre-import sites state (sites, their slots, unit associations and notes)', perm: 'inventory.edit', idempotent: true,
    async handler({ ctx, db, params }) {
      const job = (await db.query("select * from inventory_import where id = $1 and kind = 'sites' for update", [params.job])).rows[0];
      if (!job) throw new HttpError(404, 'job_not_found', 'No such import job');
      if (job.status !== 'applied') throw new HttpError(409, 'not_applied', `Job is ${job.status}`);
      // Restore from the structured snapshot: un-retire removed sites AND their slots, re-point nulled units, and
      // clear notes the import set. A legacy job whose snapshot predates this shape would lack slots/units keys.
      const snap = (job.snapshot ?? { sites: [], slots: [], units: [] }) as SitesSnapshot;
      const rolledBack = await restoreSites(db, ctx.tenantId, ctx.userId, snap);
      await db.query("update inventory_import set status = 'rolled_back' where id = $1", [job.id]);
      return { job: job.id, rolledBack };
    },
  });
}
