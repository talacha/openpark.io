import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { hashPassword, newApiKey, signToken, verifyPassword } from '../auth.js';
import { audit } from '../db.js';
import { HttpError, created, defineRoute, definePublicRoute } from '../http.js';
import type { App } from '../server.js';
import { applyInventory, loadLiveSlots, previewImport } from '../services/inventory.js';
import { COUNTRIES, DEFAULT_COUNTRY, demoInventory } from '../services/demo.js';

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'org';

const Signup = z.object({
  email: z.string().email(),
  password: z.string().min(10),
  name: z.string().optional(),
  organisation: z.string().min(2),
  country: z.string().length(2).toUpperCase(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}$/).optional(),
});

const Role = z.enum(['admin', 'supervisor', 'attendant', 'auditor']);

export function registerAuthRoutes(app: App) {
  // Called by openpark.io: creates a trial tenant with one demo site and a country-template rate plan.
  definePublicRoute(app, {
    method: 'POST', path: '/v1/signup', summary: 'Create a trial tenant', body: Signup,
    async handler({ body }) {
      const c = COUNTRIES[body.country] ?? DEFAULT_COUNTRY;
      const email = body.email.toLowerCase();
      const baseSlug = body.slug ?? slugify(body.organisation);
      const exists = await app.db.raw((db) => db.query('select 1 from app_user where email = $1', [email]));
      if (exists.rowCount) throw new HttpError(409, 'email_taken', 'An account with this email already exists');

      let tenantId = '', slug = baseSlug;
      for (let attempt = 0; ; attempt++) {
        try {
          tenantId = (await app.db.raw((db) => db.query('select create_tenant($1,$2,$3,$4,$5,$6,$7) as id',
            [slug, body.organisation, body.country, c.locale, c.currency, c.timezone, c.plateRegions]))).rows[0].id;
          break;
        } catch (e) {
          if ((e as { code?: string }).code !== '23505' || body.slug || attempt > 4) {
            if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'slug_taken', 'That tenant slug is taken');
            throw e;
          }
          slug = `${baseSlug}-${randomBytes(2).toString('hex')}`;
        }
      }

      const userId = await app.db.withTenant(tenantId, async (db) => {
        const u = await db.query('insert into app_user (email, name, password_hash, locale) values ($1,$2,$3,$4) returning id',
          [email, body.name ?? null, await hashPassword(body.password), c.locale]);
        const id = u.rows[0].id as string;
        await db.query("insert into membership (tenant_id, user_id, role) values ($1,$2,'owner')", [tenantId, id]);

        const doc = demoInventory(slug, c.timezone);
        await applyInventory(db, tenantId, doc, previewImport(await loadLiveSlots(db), doc, 'merge'));
        const site = (await db.query('select id from site where code = $1', ['DEMO-01'])).rows[0].id;
        const plan = await db.query(
          `insert into rate_plan (tenant_id, site_id, name, version, rules, currency, tax_mode) values ($1,$2,'Visitor hourly',1,$3,$4,$5) returning id`,
          [tenantId, site, JSON.stringify(c.rules), c.currency, c.rules.taxMode]);
        await db.query('update site set default_rate_plan_id = $1 where id = $2', [plan.rows[0].id, site]);
        await audit(db, tenantId, id, 'tenant.signup', 'tenant', null, { slug, country: body.country });
        return id;
      });
      return created({ token: signToken(app.cfg.JWT_SECRET, userId), tenant: { slug, name: body.organisation, locale: c.locale, currency: c.currency } });
    },
  });

  definePublicRoute(app, {
    method: 'POST', path: '/v1/auth/login', summary: 'Sign in with email and password',
    body: z.object({ email: z.string().email(), password: z.string() }),
    async handler({ body }) {
      const u = (await app.db.raw((db) => db.query('select id, password_hash, name, locale from app_user where email = $1', [body.email.toLowerCase()]))).rows[0];
      // Verify against a dummy hash when the user is unknown so timing does not reveal accounts.
      const ok = await verifyPassword(body.password, u?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
      if (!u || !ok) throw new HttpError(401, 'bad_credentials', 'Invalid email or password');
      const memberships = (await app.db.raw((db) => db.query('select * from user_memberships($1)', [u.id]))).rows
        .map((m) => ({ slug: m.slug, name: m.name, role: m.role }));
      return { token: signToken(app.cfg.JWT_SECRET, u.id), user: { name: u.name, locale: u.locale }, memberships };
    },
  });

  defineRoute(app, {
    method: 'GET', path: '/v1/me', summary: 'Current identity and tenant', perm: 'read',
    async handler({ ctx, db }) {
      const t = (await db.query('select slug, name, country, default_locale, locales, currency, plate_regions, ai_mode, terminology, slot_types from tenant')).rows[0];
      const user = ctx.userId ? (await db.query('select id, email, name, locale from app_user where id = $1', [ctx.userId])).rows[0] : null;
      return { role: ctx.role, user, tenant: t };
    },
  });

  defineRoute(app, {
    method: 'PATCH', path: '/v1/tenant', summary: 'Update tenant settings (AI mode, locales, terminology, plate regions)', perm: 'settings.edit',
    body: z.object({
      aiMode: z.enum(['off', 'assist', 'auto']).optional(),
      defaultLocale: z.string().optional(),
      locales: z.array(z.string()).min(1).optional(),
      terminology: z.record(z.record(z.string())).optional(),
      plateRegions: z.array(z.string()).optional(),
      retentionDays: z.number().int().min(1).max(3650).optional(),
      trainingExport: z.boolean().optional(),
    }),
    async handler({ ctx, db, body }) {
      const before = (await db.query('select ai_mode, default_locale, locales, terminology, plate_regions, settings from tenant')).rows[0];
      await db.query(
        `update tenant set ai_mode = coalesce($1, ai_mode), default_locale = coalesce($2, default_locale),
           locales = coalesce($3, locales), terminology = coalesce($4::jsonb, terminology),
           plate_regions = coalesce($5, plate_regions),
           settings = settings || jsonb_strip_nulls(jsonb_build_object('retentionDays', $6::int, 'trainingExport', $7::boolean))`,
        [body.aiMode ?? null, body.defaultLocale ?? null, body.locales ?? null, body.terminology ? JSON.stringify(body.terminology) : null,
          body.plateRegions ?? null, body.retentionDays ?? null, body.trainingExport ?? null]);
      await audit(db, ctx.tenantId, ctx.userId, 'tenant.update', 'tenant', before, body);
      return { ok: true };
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/users', summary: 'Add a user to the tenant; returns a one-time temporary password', perm: 'users.edit',
    body: z.object({ email: z.string().email(), name: z.string().optional(), role: Role }),
    async handler({ ctx, db, body }) {
      const email = body.email.toLowerCase();
      const temp = randomBytes(9).toString('base64url');
      let u = (await db.query('select id from app_user where email = $1', [email])).rows[0];
      const isNew = !u;
      if (!u) u = (await db.query('insert into app_user (email, name, password_hash) values ($1,$2,$3) returning id', [email, body.name ?? null, await hashPassword(temp)])).rows[0];
      const r = await db.query('insert into membership (tenant_id, user_id, role) values ($1,$2,$3) on conflict do nothing', [ctx.tenantId, u.id, body.role]);
      if (!r.rowCount) throw new HttpError(409, 'already_member', 'User already belongs to this tenant');
      await audit(db, ctx.tenantId, ctx.userId, 'user.add', 'membership', null, { email, role: body.role });
      return created({ userId: u.id, ...(isNew ? { temporaryPassword: temp } : {}) });
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/api-keys', summary: 'Create a tenant (and optionally site) scoped API key; shown once', perm: 'users.edit',
    body: z.object({ name: z.string().min(1), role: Role.default('attendant'), site: z.string().optional() }),
    async handler({ ctx, db, body }) {
      let siteId: string | null = null;
      if (body.site) {
        siteId = (await db.query('select id from site where code = $1', [body.site])).rows[0]?.id;
        if (!siteId) throw new HttpError(404, 'site_not_found', `No site ${body.site}`);
      }
      const k = newApiKey();
      await db.query('insert into api_key (tenant_id, site_id, name, prefix, key_hash, role) values ($1,$2,$3,$4,$5,$6)',
        [ctx.tenantId, siteId, body.name, k.prefix, k.hash, body.role]);
      await audit(db, ctx.tenantId, ctx.userId, 'api_key.create', 'api_key', null, { name: body.name, prefix: k.prefix, site: body.site });
      return created({ key: k.key, prefix: k.prefix });
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/webhooks', summary: 'Register a webhook endpoint; returns the signing secret once', perm: 'settings.edit',
    body: z.object({
      url: z.string().url(),
      events: z.array(z.enum(['session.opened', 'session.closed', 'slot.changed', 'read.needs_review'])).min(1),
    }),
    async handler({ ctx, db, body }) {
      const secret = `whsec_${randomBytes(24).toString('base64url')}`;
      const r = await db.query('insert into webhook_endpoint (tenant_id, url, secret, events) values ($1,$2,$3,$4) returning id',
        [ctx.tenantId, body.url, secret, body.events]);
      await audit(db, ctx.tenantId, ctx.userId, 'webhook.create', 'webhook_endpoint', null, body);
      return created({ id: r.rows[0].id, secret });
    },
  });
}
