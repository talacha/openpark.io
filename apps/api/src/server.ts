import cors from '@fastify/cors';
import type { PlateRegion } from '@openpark/core';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { sha256, verifyToken, type Role } from './auth.js';
import type { Config } from './config.js';
import { Database } from './db.js';
import { EventHub } from './events.js';
import { HttpError, registry, type Ctx } from './http.js';
import { Jobs } from './jobs.js';
import { loadPlateRegistry } from './registry.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerInventoryRoutes } from './routes/inventory.js';
import { registerMiscRoutes } from './routes/misc.js';
import { registerRateRoutes } from './routes/rates.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSlotRoutes } from './routes/slots.js';
import { LocalDiskStorage, type Storage } from './storage.js';

export type App = FastifyInstance & {
  cfg: Config;
  db: Database;
  hub: EventHub;
  jobs: Jobs;
  storage: Storage;
  plates: Map<string, PlateRegion>;
  now: () => Date;
  authenticate: (req: FastifyRequest) => Promise<Ctx>;
};

export interface BuildOpts { cfg: Config; now?: () => Date; storage?: Storage }

export async function buildApp({ cfg, now = () => new Date(), storage }: BuildOpts): Promise<App> {
  registry.length = 0;
  const app = Fastify({ logger: cfg.LOG_LEVEL === 'silent' ? false : { level: cfg.LOG_LEVEL }, bodyLimit: 12 * 1024 * 1024 }) as unknown as App;
  await app.register(cors, { origin: cfg.CORS_ORIGIN === '*' ? true : cfg.CORS_ORIGIN.split(','), exposedHeaders: ['Idempotent-Replayed'] });

  app.decorate('cfg', cfg);
  app.decorate('db', new Database(cfg.DATABASE_URL, cfg.DB_POOL_MAX));
  app.decorate('hub', new EventHub(cfg.LISTEN_DATABASE_URL ?? cfg.DATABASE_URL, app.log, cfg.SERVERLESS));
  app.decorate('jobs', new Jobs(cfg, app.db, app.log));
  app.decorate('storage', storage ?? new LocalDiskStorage(cfg.STORAGE_DIR));
  app.decorate('plates', loadPlateRegistry(cfg.REGISTRY_DIR));
  app.decorate('now', now);

  app.decorate('authenticate', async (req: FastifyRequest): Promise<Ctx> => {
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const query = req.query as Record<string, string | undefined>;
    const token = bearer ?? query.access_token; // EventSource cannot set headers
    const apiKey = (req.headers['x-api-key'] as string | undefined) ?? (token?.startsWith('op_') ? token : undefined);

    if (apiKey) {
      const r = await app.db.raw((db) => db.query('select * from resolve_api_key($1)', [sha256(apiKey)]));
      const row = r.rows[0];
      if (!row) throw new HttpError(401, 'invalid_api_key', 'Unknown or revoked API key');
      const slug = await app.db.withTenant(row.tenant_id, async (db) => (await db.query('select slug from tenant')).rows[0].slug as string);
      return { tenantId: row.tenant_id, tenantSlug: slug, role: row.role as Role, userId: null, siteId: row.site_id };
    }
    if (!token) throw new HttpError(401, 'unauthenticated', 'Missing credentials');
    const claims = verifyToken(cfg.JWT_SECRET, token);
    if (!claims) throw new HttpError(401, 'invalid_token', 'Invalid or expired token');
    const wanted = (req.headers['x-tenant'] as string | undefined) ?? query.tenant;
    const rows = (await app.db.raw((db) => db.query('select * from user_memberships($1)', [claims.sub]))).rows;
    const m = wanted ? rows.find((x) => x.slug === wanted) : rows.length === 1 ? rows[0] : undefined;
    if (!m) throw new HttpError(wanted ? 403 : 400, wanted ? 'not_a_member' : 'tenant_required', wanted ? 'You are not a member of that tenant' : 'Send X-Tenant: <slug>');
    return { tenantId: m.tenant_id, tenantSlug: m.slug, role: m.role as Role, userId: claims.sub, siteId: null };
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'validation_failed', message: 'Invalid request', details: err.issues } });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: { code: err.code ?? 'bad_request', message: err.message } });
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'internal', message: 'Internal error' } });
  });

  let requests = 0;
  const byStatus = new Map<number, number>();
  app.addHook('onResponse', async (_req, reply) => {
    requests++;
    byStatus.set(reply.statusCode, (byStatus.get(reply.statusCode) ?? 0) + 1);
  });
  app.get('/metrics', async (_req, reply) => {
    const lines = ['# TYPE openpark_http_requests_total counter', `openpark_http_requests_total ${requests}`,
      ...[...byStatus].map(([s, n]) => `openpark_http_responses_total{status="${s}"} ${n}`)];
    return reply.type('text/plain').send(lines.join('\n') + '\n');
  });
  app.get('/healthz', async () => {
    await app.db.raw((db) => db.query('select 1'));
    return { ok: true };
  });

  registerAuthRoutes(app);
  registerSessionRoutes(app);
  registerSlotRoutes(app);
  registerRateRoutes(app);
  registerInventoryRoutes(app);
  registerMiscRoutes(app);

  app.addHook('onClose', async () => {
    await app.hub.stop();
    await app.jobs.stop();
    await app.db.close();
  });
  await app.hub.start();
  await app.jobs.start(app);
  return app;
}
