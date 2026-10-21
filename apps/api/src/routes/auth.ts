import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ROLES, hashPassword, newApiKey, signToken, verifyPassword } from '../auth.js';
import { localAuthEnabled } from '../config.js';
import { audit } from '../db.js';
import { HttpError, created, defineRoute, definePublicRoute } from '../http.js';
import type { App } from '../server.js';
import { provisionTenant, type Owner } from '../services/tenants.js';

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'org';

const Signup = z.object({
  /** Local accounts only; with an external identity (Supabase) the email comes from the access token. */
  email: z.string().email().optional(),
  password: z.string().min(10).optional(),
  name: z.string().optional(),
  organisation: z.string().min(2),
  country: z.string().length(2).toUpperCase(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}$/).optional(),
});

const Role = z.enum(ROLES);

export function registerAuthRoutes(app: App) {
  // Called by openpark.io: creates a trial tenant with one demo site and a country-template rate plan.
  definePublicRoute(app, {
    method: 'POST', path: '/v1/signup', summary: 'Create a trial tenant', body: Signup,
    async handler({ body, req }) {
      if (!app.cfg.TRIAL_SIGNUP) throw new HttpError(403, 'signup_closed', 'Sign-up is closed while OpenPark is in a closed preview. Ask for an invitation.');
      const local = !!body.password;
      let owner: Owner;
      if (local) {
        if (!localAuthEnabled(app.cfg)) throw new HttpError(400, 'local_auth_disabled', 'Sign up with the configured identity provider');
        if (!body.email) throw new HttpError(400, 'email_required', 'Email is required');
        const exists = await app.db.raw((db) => db.query('select 1 from app_user where email = $1', [body.email!.toLowerCase()]));
        if (exists.rowCount) throw new HttpError(409, 'email_taken', 'An account with this email already exists');
        owner = { kind: 'new_local_user', email: body.email.toLowerCase(), name: body.name, password: body.password! };
      } else {
        const who = await app.identify(req); // 401 unless a valid external token is presented
        owner = { kind: 'user', userId: who.userId, name: body.name };
      }
      const t = await provisionTenant(app, { organisation: body.organisation, country: body.country, slug: body.slug, owner });
      const tenant = { slug: t.slug, name: body.organisation, locale: t.locale, currency: t.currency };
      return created(local ? { token: signToken(app.cfg.JWT_SECRET, t.ownerId!), tenant } : { tenant });
    },
  });

  definePublicRoute(app, {
    method: 'POST', path: '/v1/auth/login', summary: 'Sign in with email and password',
    body: z.object({ email: z.string().email(), password: z.string() }),
    async handler({ body }) {
      if (!localAuthEnabled(app.cfg)) throw new HttpError(404, 'local_auth_disabled', 'Sign in with the configured identity provider');
      const u = (await app.db.raw((db) => db.query('select id, password_hash, name, locale from app_user where email = $1 and password_hash is not null', [body.email.toLowerCase()]))).rows[0];
      // Verify against a dummy hash when the user is unknown so timing does not reveal accounts.
      const ok = await verifyPassword(body.password, u?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
      if (!u || !ok) throw new HttpError(401, 'bad_credentials', 'Invalid email or password');
      const memberships = (await app.db.raw((db) => db.query('select * from user_memberships($1)', [u.id]))).rows
        .map((m) => ({ slug: m.slug, name: m.name, roles: m.roles }));
      return { token: signToken(app.cfg.JWT_SECRET, u.id), user: { name: u.name, locale: u.locale }, memberships };
    },
  });

  defineRoute(app, {
    method: 'GET', path: '/v1/me', summary: 'Current identity and tenant', perm: 'me',
    async handler({ ctx, db }) {
      const t = (await db.query(
        `select slug, name, country, default_locale, locales, currency, plate_regions, ai_mode, terminology, slot_types,
           coalesce((settings->>'retentionDays')::int, 30) as retention_days,
           coalesce((settings->>'trainingExport')::boolean, false) as training_export from tenant`)).rows[0];
      const user = ctx.userId ? (await db.query('select id, email, name, phone, locale from app_user where id = $1', [ctx.userId])).rows[0] : null;
      const unit = ctx.unitId ? (await db.query('select code, name from unit where id = $1', [ctx.unitId])).rows[0] : null;
      return { roles: ctx.roles, user, unit, superadmin: ctx.superadmin, tenant: t };
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
      events: z.array(z.enum(['session.opened', 'session.closed', 'slot.changed', 'read.needs_review', 'pass.overstay'])).min(1),
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
