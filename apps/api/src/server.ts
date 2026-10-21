import cors from '@fastify/cors';
import type { PlateRegion } from '@openpark/core';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { sha256, verifyToken, type Role } from './auth.js';
import { localAuthEnabled, type Config } from './config.js';
import { IdentityVerifier, type ExternalIdentity } from './identity.js';
import { createNotifier, type Notifier } from './notify/notifier.js';
import { waitUntil } from '@vercel/functions';
import { Database } from './db.js';
import { EventHub } from './events.js';
import { HttpError, registry, type Ctx } from './http.js';
import { Jobs } from './jobs.js';
import { loadPlateRegistry } from './registry.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerInventoryRoutes } from './routes/inventory.js';
import { registerMiscRoutes } from './routes/misc.js';
import { registerPassRoutes } from './routes/passes.js';
import { registerPeopleRoutes } from './routes/people.js';
import { registerRateRoutes } from './routes/rates.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSlotRoutes } from './routes/slots.js';
import { LocalDiskStorage, type Storage } from './storage.js';

export interface Identity { userId: string; email: string | null; superadmin: boolean }

export type App = FastifyInstance & {
  verifier: IdentityVerifier;
  notifier: Notifier;
  /** Run work after the response; on Vercel it is kept alive with waitUntil. */
  background: (p: Promise<unknown>) => void;
  identify: (req: FastifyRequest) => Promise<Identity>;
  cfg: Config;
  db: Database;
  hub: EventHub;
  jobs: Jobs;
  storage: Storage;
  plates: Map<string, PlateRegion>;
  now: () => Date;
  authenticate: (req: FastifyRequest) => Promise<Ctx>;
};

export interface BuildOpts { cfg: Config; now?: () => Date; storage?: Storage; notifier?: Notifier; verifier?: IdentityVerifier }

/** First sight of an external identity creates the user, links an existing email, claims invitations, grants super admin. */
async function resolveExternalUser(app: App, ext: ExternalIdentity): Promise<Identity> {
  const isSuper = (email: string | null) => !!email && app.cfg.SUPERADMIN_EMAILS.includes(email);
  return app.db.raw(async (db) => {
    const found = (await db.query('select id, email, is_superadmin from app_user where auth_id = $1', [ext.sub])).rows[0];
    if (found) {
      if (!found.is_superadmin && isSuper(found.email)) await db.query('update app_user set is_superadmin = true where id = $1', [found.id]);
      return { userId: found.id as string, email: found.email as string, superadmin: found.is_superadmin || isSuper(found.email) };
    }
    if (!ext.email) throw new HttpError(401, 'email_required', 'The identity provider did not supply an email address');
    await db.query('begin');
    try {
      // Link a pre-existing account with the same (provider-verified) email, else create one.
      let u = (await db.query('update app_user set auth_id = $1 where email = $2 and auth_id is null returning id, is_superadmin', [ext.sub, ext.email])).rows[0];
      if (!u) u = (await db.query('insert into app_user (email, name, auth_id) values ($1, $2, $3) returning id, is_superadmin', [ext.email, ext.name, ext.sub])).rows[0];
      if (isSuper(ext.email) && !u.is_superadmin) { await db.query('update app_user set is_superadmin = true where id = $1', [u.id]); u.is_superadmin = true; }
      await db.query('select claim_invites($1, $2)', [u.id, ext.email]);
      await db.query('commit');
      return { userId: u.id as string, email: ext.email, superadmin: !!u.is_superadmin };
    } catch (e) {
      await db.query('rollback').catch(() => {});
      if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'identity_conflict', 'That email belongs to another sign-in method');
      throw e;
    }
  });
}

export async function buildApp({ cfg, now = () => new Date(), storage, notifier, verifier }: BuildOpts): Promise<App> {
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
  app.decorate('verifier', verifier ?? new IdentityVerifier(cfg));
  app.decorate('notifier', notifier ?? createNotifier(cfg, app.log));
  app.decorate('background', (p: Promise<unknown>) => {
    const safe = p.catch((e) => app.log.error(e, 'background task failed'));
    if (cfg.SERVERLESS) waitUntil(safe);
  });

  /** Who is calling: a local session token, an external (Supabase/OIDC) token, resolved to an app_user row. */
  app.decorate('identify', async (req: FastifyRequest): Promise<Identity> => {
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const token = bearer ?? (req.query as Record<string, string | undefined>).access_token; // EventSource cannot set headers
    if (!token) throw new HttpError(401, 'unauthenticated', 'Missing credentials');

    if (localAuthEnabled(cfg)) {
      const claims = verifyToken(cfg.JWT_SECRET, token);
      if (claims) {
        const u = (await app.db.raw((db) => db.query('select email, is_superadmin from app_user where id = $1', [claims.sub]))).rows[0];
        if (!u) throw new HttpError(401, 'invalid_token', 'Unknown user');
        return { userId: claims.sub, email: u.email, superadmin: u.is_superadmin };
      }
    }
    const ext = await app.verifier.verify(token);
    if (!ext) throw new HttpError(401, 'invalid_token', 'Invalid or expired token');
    return resolveExternalUser(app, ext);
  });

  app.decorate('authenticate', async (req: FastifyRequest): Promise<Ctx> => {
    const query = req.query as Record<string, string | undefined>;
    const headerKey = req.headers['x-api-key'] as string | undefined;
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : query.access_token;
    const apiKey = headerKey ?? (bearer?.startsWith('op_') ? bearer : undefined);

    if (apiKey) {
      const r = await app.db.raw((db) => db.query('select * from resolve_api_key($1)', [sha256(apiKey)]));
      const row = r.rows[0];
      if (!row) throw new HttpError(401, 'invalid_api_key', 'Unknown or revoked API key');
      const t = await app.db.withTenant(row.tenant_id, async (db) => (await db.query('select slug, suspended_at from tenant')).rows[0]);
      if (t.suspended_at) throw new HttpError(403, 'tenant_suspended', 'This tenant is suspended');
      return { tenantId: row.tenant_id, tenantSlug: t.slug, roles: [row.role as Role], userId: null, siteId: row.site_id, unitId: null, superadmin: false };
    }

    const who = await app.identify(req);
    const wanted = (req.headers['x-tenant'] as string | undefined) ?? query.tenant;
    const rows = (await app.db.raw((db) => db.query('select * from user_memberships($1)', [who.userId]))).rows;
    const m = wanted ? rows.find((x) => x.slug === wanted) : rows.length === 1 ? rows[0] : undefined;
    if (m) {
      if (m.suspended && !who.superadmin) throw new HttpError(403, 'tenant_suspended', 'This tenant is suspended');
      return { tenantId: m.tenant_id, tenantSlug: m.slug, roles: m.roles as Role[], userId: who.userId, siteId: null, unitId: m.unit_id, superadmin: who.superadmin };
    }
    // Platform super admins may enter any tenant, with owner powers; writes are audited (see http.ts).
    if (who.superadmin && wanted) {
      const t = (await app.db.raw((db) => db.query('select * from tenant_by_slug($1)', [wanted]))).rows[0];
      if (!t) throw new HttpError(404, 'tenant_not_found', `No tenant ${wanted}`);
      return { tenantId: t.id, tenantSlug: t.slug, roles: [], userId: who.userId, siteId: null, unitId: null, superadmin: true };
    }
    throw new HttpError(wanted ? 403 : 400, wanted ? 'not_a_member' : 'tenant_required', wanted ? 'You are not a member of that tenant' : 'Send X-Tenant: <slug>');
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
  registerPassRoutes(app);
  registerPeopleRoutes(app);
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
