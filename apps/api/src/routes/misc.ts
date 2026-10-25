import { matchPlateClass, normalizePlate } from '@openpark/core';
import { z } from 'zod';
import { can } from '../auth.js';
import { emit } from '../db.js';
import { HttpError, definePublicRoute, defineRoute, openApiDocument } from '../http.js';
import { imageAssetByKey, parseImageStorageKey } from '../images.js';
import type { App } from '../server.js';
import { signUrl, verifySignedUrl } from '../storage.js';
import { processPassReminders, processStayAlerts } from '../services/passes.js';
import { resolveSite } from '../services/sessions.js';

interface AlprResponse {
  candidates: { text: string; confidence: number; region?: string; engine?: string }[];
  crop?: string;
  latencyMs?: number;
  vehicle?: { bodyType?: string; make?: string; model?: string; color?: string };
}

export function registerMiscRoutes(app: App) {
  definePublicRoute(app, { method: 'GET', path: '/openapi.json', summary: 'OpenAPI 3.1 document', handler: async () => openApiDocument() });

  // Keypad character sets and patterns come from the plate-format registry.
  definePublicRoute(app, {
    method: 'GET', path: '/v1/plate-regions', summary: 'Plate-format registry (charset, patterns, confusables per region)',
    handler: async () => [...app.plates.values()].map((r) => ({ region: r.region, name: r.name, charset: r.charset, confusables: r.confusables })),
  });

  // Content-Type is derived from the (signed, server-controlled) key's extension — crops are always .jpg, DB-backed
  // images are always .webp — rather than hardcoded, so a PNG/WebP avatar is not mislabelled as JPEG. The extension
  // comes from the key the server itself minted at upload, never from client input, so it is trusted.
  const MIME_BY_EXT: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  definePublicRoute(app, {
    method: 'GET', path: '/v1/files/:key', summary: 'Signed file download (plate crop, avatar or evidence)',
    async handler({ req, reply }) {
      const { key } = req.params as { key: string };
      const { exp, sig } = req.query as { exp?: string; sig?: string };
      if (!exp || !sig || !verifySignedUrl(app.cfg.JWT_SECRET, key, Number(exp), sig)) throw new HttpError(403, 'bad_signature', 'Link expired or invalid');

      // DB-backed images carry their tenant in the key, so the RLS context can be selected without a session.
      const dbKey = parseImageStorageKey(key);
      if (dbKey) {
        const asset = await app.db.withTenant(dbKey.tenantId, (db) => imageAssetByKey(db, dbKey.tenantId, dbKey.key));
        if (!asset) throw new HttpError(404, 'file_not_found', 'No such file');
        return reply.type(asset.mime).header('cache-control', 'private, max-age=300').send(asset.data);
      }

      const ext = key.split('.').pop()?.toLowerCase() ?? '';
      return reply.type(MIME_BY_EXT[ext] ?? 'application/octet-stream').send(await app.storage.get(key));
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/alpr/read', summary: 'Image in, ranked plate candidates out', perm: 'checkin',
    body: z.object({ site: z.string(), image: z.string().min(1).describe('base64 JPEG/PNG'), region: z.string().optional() }),
    async handler({ ctx, db, body, after }) {
      const tenant = (await db.query('select ai_mode, plate_regions from tenant')).rows[0];
      if (tenant.ai_mode === 'off') throw new HttpError(403, 'ai_disabled', 'AI plate reading is off for this tenant');
      if (!app.cfg.ALPR_URL) throw new HttpError(503, 'alpr_unavailable', 'No ALPR worker is configured');
      const site = await resolveSite(db, ctx, body.site);
      const region = body.region ?? tenant.plate_regions[0];

      const started = Date.now();
      let res: AlprResponse;
      try {
        const r = await fetch(`${app.cfg.ALPR_URL}/read`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ image: body.image, region }), signal: AbortSignal.timeout(15_000),
        });
        if (!r.ok) throw new Error(`worker returned ${r.status}`);
        res = (await r.json()) as AlprResponse;
      } catch (e) {
        throw new HttpError(502, 'alpr_failed', (e as Error).message);
      }

      const reg = app.plates.get(region ?? '');
      const candidates = res.candidates.map((c) => {
        const norm = normalizePlate(c.text);
        return { text: c.text, norm, confidence: c.confidence, region: c.region ?? region, engine: c.engine,
          formatValid: reg ? !!matchPlateClass(reg, norm) : null };
      });
      const top = candidates[0];
      const threshold = site.settings.aiThreshold ?? 0.95;
      // Auto commits only a confident, format-valid read; everything else goes to the attendant.
      const decision = top && tenant.ai_mode === 'auto' && top.confidence >= threshold && top.formatValid !== false ? 'auto' : 'review';

      let cropKey: string | null = null;
      if (res.crop) {
        cropKey = `${ctx.tenantId}/crops/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
        await app.storage.put(cropKey, Buffer.from(res.crop, 'base64')); // the crop, never the full frame
      }
      const read = await db.query(
        `insert into plate_read (tenant_id, crop_key, text_raw, text_norm, region, confidence, engine, latency_ms)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [ctx.tenantId, cropKey, top?.text ?? null, top?.norm ?? null, top?.region ?? region, top?.confidence ?? null, top?.engine ?? null, res.latencyMs ?? Date.now() - started]);
      if (decision === 'review') {
        const data = { readId: read.rows[0].id, site: site.code, top: top?.text ?? null, confidence: top?.confidence ?? null };
        await emit(db, ctx.tenantId, 'read.needs_review', data);
        after(() => app.jobs.enqueue(ctx.tenantId, 'read.needs_review', data));
      }
      return {
        readId: read.rows[0].id, decision, threshold, candidates, vehicle: res.vehicle ?? null,
        cropUrl: cropKey ? signUrl(app.cfg.JWT_SECRET, cropKey) : null,
      };
    },
  });

  defineRoute(app, {
    method: 'GET', path: '/v1/reports/shifts', summary: 'Sessions and cash per attendant shift', perm: 'read',
    query: z.object({ site: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    async handler({ ctx, db, query: q }) {
      await resolveSite(db, ctx, q.site);
      const rows = (await db.query(
        `select e.actor_id, coalesce(u.name, u.email, 'api key') as attendant,
           count(*) filter (where e.type = 'check_in')::int as check_ins,
           count(*) filter (where e.type = 'check_out')::int as check_outs,
           coalesce(sum((e.payload->>'amount')::int) filter (where e.type = 'payment' and e.payload->>'method' = 'cash'), 0)::int as cash,
           coalesce(sum((e.payload->>'amount')::int) filter (where e.type = 'payment' and e.payload->>'method' = 'card'), 0)::int as card,
           coalesce(sum((e.payload->>'amount')::int) filter (where e.type = 'payment' and e.payload->>'method' = 'account'), 0)::int as account
         from session_event e join session s on s.id = e.session_id join site st on st.id = s.site_id
         left join app_user u on u.id = e.actor_id
         where st.code = $1
           and e.server_at >= ($2::date::timestamp at time zone st.timezone)
           and e.server_at < (($2::date + 1)::timestamp at time zone st.timezone)
         group by e.actor_id, 2 order by 2`, [q.site, q.date])).rows;
      return { site: q.site, date: q.date, attendants: rows };
    },
  });

  defineRoute(app, {
    method: 'GET', path: '/v1/audit', summary: 'Append-only audit log for settings, users and inventory', perm: 'audit.read',
    query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
    async handler({ db, query }) {
      return (await db.query(
        `select a.id, a.at, a.action, a.entity, a.before, a.after, coalesce(u.name, u.email) as actor
         from audit_event a left join app_user u on u.id = a.actor_id order by a.id desc limit $1`, [query.limit])).rows;
    },
  });

  // Vercel Cron target: retention purge (replaces the pg-boss schedule, which needs a long-lived worker).
  definePublicRoute(app, {
    method: 'GET', path: '/v1/cron/retention', summary: 'Purge plate crops past retention (cron only)',
    async handler({ req }) {
      if (!app.cfg.CRON_SECRET || req.headers.authorization !== `Bearer ${app.cfg.CRON_SECRET}`) throw new HttpError(401, 'unauthorized', 'Cron secret required');
      const keys = (await app.db.raw((db) => db.query('select purge_idempotency_keys(7) as n'))).rows[0].n;
      return { purged: await app.jobs.purge(app), idempotencyKeys: keys };
    },
  });

  // Vercel Cron target: guest-pass reminders (10 h, 11 h) and overstay notices (12 h) for open pass stays.
  definePublicRoute(app, {
    method: 'GET', path: '/v1/cron/pass-reminders', summary: 'Send due guest-pass reminders (cron only)',
    async handler({ req }) {
      if (!app.cfg.CRON_SECRET || req.headers.authorization !== `Bearer ${app.cfg.CRON_SECRET}`) throw new HttpError(401, 'unauthorized', 'Cron secret required');
      return { ...(await processPassReminders(app)), stays: await processStayAlerts(app), webhooks: await app.jobs.drainDeliveries(app) };
    },
  });

  // Server-sent events: occupancy, sessions and low-confidence reads for the caller's tenant.
  app.get('/v1/events', async (req, reply) => {
    const ctx = await app.authenticate(req);
    // Residents must not see the lot's plates and sessions.
    if (!can(ctx, 'read')) throw new HttpError(403, 'forbidden', 'This account cannot subscribe to live events');
    if (!app.cfg.SSE_ENABLED) throw new HttpError(501, 'realtime_polling', 'Live streaming is disabled on this deployment; poll instead');
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive',
      'access-control-allow-origin': app.cfg.CORS_ORIGIN === '*' ? '*' : app.cfg.CORS_ORIGIN, 'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    const unsub = app.hub.subscribe(ctx.tenantId, (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
    const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
    // Functions have a maximum duration; end the stream cleanly before it and let EventSource reconnect.
    const cap = app.cfg.SSE_MAX_SECONDS ? setTimeout(() => res.end(), app.cfg.SSE_MAX_SECONDS * 1000) : null;
    req.raw.on('close', () => { clearInterval(beat); if (cap) clearTimeout(cap); unsub(); });
  });
}
