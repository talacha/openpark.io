import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { can, describeRoles, type Permission, type Role } from './auth.js';
import type { Db } from './db.js';
import type { App } from './server.js';

/** Query-string boolean: `z.coerce.boolean()` would turn the string "false" into true. */
export const boolQuery = (def = false) => z.enum(['true', 'false', '1', '0']).default(def ? 'true' : 'false').transform((v) => v === 'true' || v === '1');

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export interface Ctx {
  tenantId: string;
  tenantSlug: string;
  /** Roles in this property (one or more). */
  roles: Role[];
  userId: string | null;
  /** Set when an API key is scoped to one site. */
  siteId: string | null;
  /** Residents belong to a unit. */
  unitId: string | null;
  /** Whether the resident's unit-access grant is verified (only verified residents may issue passes). False for API keys and super admins. */
  unitVerified: boolean;
  /** Platform super admin acting inside a tenant they are not a member of. */
  superadmin: boolean;
}

export interface Reply<T = unknown> { status: number; body: T }
export const created = <T>(body: T): Reply<T> => ({ status: 201, body });

export interface HandlerArgs<B, Q> {
  app: App;
  req: FastifyRequest;
  reply: FastifyReply;
  body: B;
  query: Q;
  params: Record<string, string>;
  ctx: Ctx;
  db: Db;
  /** Run after the transaction commits (webhooks, side effects). */
  after: (fn: () => void | Promise<void>) => void;
}

export interface RouteDef<B extends ZodTypeAny, Q extends ZodTypeAny> {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  summary: string;
  perm: Permission;
  body?: B;
  query?: Q;
  /** Writes require an Idempotency-Key header and replay stored responses. */
  idempotent?: boolean;
  /**
   * Replay-safe writes: the Idempotency-Key is OPTIONAL, but when a client sends one the response is stored and
   * replayed exactly like `idempotent`. Used for CRUD creates (unit/site/zone/slot) so a lost-response retry replays
   * the original 201 instead of surfacing a false "already exists" conflict — without forcing the header on the many
   * internal/import callers that create inventory without a key. Money writes keep `idempotent` (key required).
   */
  replaySafe?: boolean;
  handler: (a: HandlerArgs<z.infer<B>, z.infer<Q>>) => Promise<unknown | Reply>;
}

export interface PublicRouteDef<B extends ZodTypeAny> {
  method: 'GET' | 'POST';
  path: string;
  summary: string;
  body?: B;
  handler: (a: { app: App; req: FastifyRequest; reply: FastifyReply; body: z.infer<B> }) => Promise<unknown | Reply>;
}

export const registry: { method: string; path: string; summary: string; perm: string; body?: ZodTypeAny; query?: ZodTypeAny; idempotent?: boolean; replaySafe?: boolean }[] = [];

const isReply = (x: unknown): x is Reply => !!x && typeof x === 'object' && 'status' in x && 'body' in x;

export function defineRoute<B extends ZodTypeAny = z.ZodUndefined, Q extends ZodTypeAny = z.ZodUndefined>(app: App, def: RouteDef<B, Q>) {
  registry.push({ method: def.method, path: def.path, summary: def.summary, perm: def.perm, body: def.body, query: def.query, idempotent: def.idempotent, replaySafe: def.replaySafe });
  app.route({
    method: def.method,
    url: def.path,
    handler: async (req, reply) => {
      const ctx = await app.authenticate(req);
      if (!can(ctx, def.perm)) throw new HttpError(403, 'forbidden', `${describeRoles(ctx)} lacks ${def.perm}`);
      const body = def.body ? def.body.parse(req.body) : undefined;
      const query = def.query ? def.query.parse(req.query) : undefined;
      const idemKey = req.headers['idempotency-key'];
      if (def.idempotent && typeof idemKey !== 'string') throw new HttpError(400, 'idempotency_key_required', 'Idempotency-Key header is required');
      // Replay-safe routes honour a key when the client sends one, but do not require it.
      const useIdem = def.idempotent || (def.replaySafe && typeof idemKey === 'string');

      const afters: (() => void | Promise<void>)[] = [];
      const result = await app.db.withTenant(ctx.tenantId, async (db) => {
        let hash = '';
        if (useIdem) {
          hash = createHash('sha256').update(`${def.method} ${req.url} ${JSON.stringify(body ?? null)}`).digest('hex');
          const prior = await db.query('select request_hash, status, response from idempotency_key where key = $1', [idemKey]);
          if (prior.rows[0]) {
            if (prior.rows[0].request_hash !== hash) throw new HttpError(422, 'idempotency_key_reuse', 'Idempotency-Key was used with a different request');
            return { replayed: true, status: prior.rows[0].status as number, body: prior.rows[0].response };
          }
        }
        const out = await def.handler({
          app, req, reply, body, query, ctx, db,
          params: req.params as Record<string, string>,
          after: (fn) => { afters.push(fn); },
        } as HandlerArgs<z.infer<B>, z.infer<Q>>);
        const r: Reply = isReply(out) ? out : { status: 200, body: out };
        if (ctx.superadmin && def.method !== 'GET') {
          // A platform super admin acting inside a tenant they do not belong to: leave a trail the tenant can see.
          await db.query('insert into audit_event (tenant_id, actor_id, action, entity, after) values ($1,$2,$3,$4,$5)',
            [ctx.tenantId, ctx.userId, 'platform.write', `${def.method} ${def.path}`, JSON.stringify({ url: req.url })]);
        }
        if (useIdem) {
          await db.query('insert into idempotency_key (tenant_id, key, request_hash, status, response) values ($1,$2,$3,$4,$5)',
            [ctx.tenantId, idemKey, hash, r.status, JSON.stringify(r.body ?? null, (k, v) => (k === 'temporaryPassword' ? null : v))]); // one-time passwords are never stored
        }
        return { replayed: false, ...r };
      }).catch((e) => {
        if (useIdem && e?.code === '23505' && e?.constraint === 'idempotency_key_pkey') {
          throw new HttpError(409, 'request_in_progress', 'A request with this Idempotency-Key is still being processed');
        }
        throw e;
      });
      // After-commit work (webhooks, notifications) must outlive the response: waitUntil on Vercel.
      for (const fn of afters) app.background(Promise.resolve().then(fn));
      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.code(result.status).send(result.body);
    },
  });
}

export function definePublicRoute<B extends ZodTypeAny = z.ZodUndefined>(app: App, def: PublicRouteDef<B>) {
  registry.push({ method: def.method, path: def.path, summary: def.summary, perm: 'public', body: def.body });
  app.route({
    method: def.method,
    url: def.path,
    handler: async (req, reply) => {
      const body = def.body ? def.body.parse(req.body) : undefined;
      const out = await def.handler({ app, req, reply, body });
      const r: Reply = isReply(out) ? out : { status: 200, body: out };
      return reply.code(r.status).send(r.body);
    },
  });
}

/** Platform-level routes: the caller must be a super admin; no tenant is selected. */
export function definePlatformRoute<B extends ZodTypeAny = z.ZodUndefined>(app: App, def: {
  method: 'GET' | 'POST'; path: string; summary: string; body?: B;
  /** Writes require an Idempotency-Key header and replay the stored response (see `idempotent` on RouteDef). */
  idempotent?: boolean;
  /** Writes honour an Idempotency-Key when the client sends one, but do not require it (see `replaySafe` on RouteDef). */
  replaySafe?: boolean;
  handler: (a: { app: App; req: FastifyRequest; body: z.infer<B>; userId: string }) => Promise<unknown | Reply>;
}) {
  registry.push({ method: def.method, path: def.path, summary: def.summary, perm: 'platform', body: def.body, idempotent: def.idempotent, replaySafe: def.replaySafe });
  app.route({
    method: def.method, url: def.path,
    handler: async (req, reply) => {
      const who = await app.identify(req);
      if (!who.superadmin) throw new HttpError(403, 'forbidden', 'Platform administrators only');
      const body = def.body ? def.body.parse(req.body) : undefined;
      const idemKey = req.headers['idempotency-key'];
      if (def.idempotent && typeof idemKey !== 'string') throw new HttpError(400, 'idempotency_key_required', 'Idempotency-Key header is required');
      const useIdem = (def.idempotent || def.replaySafe) && typeof idemKey === 'string';

      const run = async (): Promise<Reply> => {
        const out = await def.handler({ app, req, body, userId: who.userId });
        return isReply(out) ? out : { status: 200, body: out };
      };

      if (!useIdem) {
        const r = await run();
        return reply.code(r.status).send(r.body);
      }

      // Actor-scoped idempotency: platform writes are not inside a tenant tx, so the (super admin, key) pair is
      // reserved up front in platform_idempotency_key. That stops a lost-response retry OR a double submit from
      // running the handler twice — provisionTenant's auto-suffixed-slug path would otherwise create a second org.
      const key = idemKey as string;
      const hash = createHash('sha256').update(`${def.method} ${req.url} ${JSON.stringify(body ?? null)}`).digest('hex');
      let reserved = false;
      try {
        await app.db.raw((db) => db.query('insert into platform_idempotency_key (actor_id, key, request_hash, status) values ($1,$2,$3,0)', [who.userId, key, hash]));
        reserved = true;
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e; // only a key clash falls through to replay/in-flight below
      }
      if (!reserved) {
        const prior = (await app.db.raw((db) => db.query('select request_hash, status, response from platform_idempotency_key where actor_id = $1 and key = $2', [who.userId, key]))).rows[0];
        if (!prior || prior.status === 0) throw new HttpError(409, 'request_in_progress', 'A request with this Idempotency-Key is still being processed');
        if (prior.request_hash !== hash) throw new HttpError(422, 'idempotency_key_reuse', 'Idempotency-Key was used with a different request');
        reply.header('Idempotent-Replayed', 'true');
        return reply.code(prior.status as number).send(prior.response);
      }
      let r: Reply;
      try {
        r = await run();
      } catch (e) {
        // The write failed: drop the reservation so the caller can retry the same key.
        await app.db.raw((db) => db.query('delete from platform_idempotency_key where actor_id = $1 and key = $2 and status = 0', [who.userId, key])).catch(() => {});
        throw e;
      }
      await app.db.raw((db) => db.query('update platform_idempotency_key set status = $3, response = $4 where actor_id = $1 and key = $2',
        [who.userId, key, r.status, JSON.stringify(r.body ?? null, (k, v) => (k === 'temporaryPassword' ? null : v))])); // one-time passwords are never stored
      return reply.code(r.status).send(r.body);
    },
  });
}

export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of registry) {
    const path = r.path.replace(/:(\w+)/g, '{$1}');
    const params = [...r.path.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const queryProps = r.query ? ((zodToJsonSchema(r.query, { target: 'openApi3' }) as { properties?: Record<string, unknown> }).properties ?? {}) : {};
    const queryParams = Object.entries(queryProps).map(([name, schema]) => ({ name, in: 'query', schema }));
    (paths[path] ??= {})[r.method.toLowerCase()] = {
      summary: r.summary,
      'x-permission': r.perm,
      parameters: [
        ...params, ...queryParams,
        ...(r.idempotent ? [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }]
          : r.replaySafe ? [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } }] : []),
      ],
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: zodToJsonSchema(r.body, { target: 'openApi3' }) } } } } : {}),
      responses: { '200': { description: 'OK' }, '4XX': { description: 'Error: { error: { code, message, details? } }' } },
      ...(r.perm === 'public' ? {} : { security: [{ bearer: [] }, { apiKey: [] }] }),
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'OpenPark API', version: '1.0.0', license: { name: 'AGPL-3.0-only' } },
    servers: [{ url: '/' }],
    paths,
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } },
  };
}
