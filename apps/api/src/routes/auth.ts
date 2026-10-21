import { looksPublicHttpUrl } from '../netguard.js';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ROLES, hashPassword, newApiKey, signToken, verifyPassword } from '../auth.js';
import { localAuthEnabled } from '../config.js';
import { audit } from '../db.js';
import { HttpError, created, defineRoute, definePublicRoute } from '../http.js';
import type { App } from '../server.js';
import { signUrl } from '../storage.js';
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

const WebhookEvent = z.enum(['session.opened', 'session.closed', 'slot.changed', 'read.needs_review', 'pass.overstay']);

export function registerAuthRoutes(app: App) {
  const assertWebhookUrl = (url: string) => {
    if (!app.cfg.WEBHOOKS_ALLOW_PRIVATE && !looksPublicHttpUrl(url)) throw new HttpError(400, 'validation_failed', 'Webhook URLs must be public http(s) addresses');
  };
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
           coalesce((settings->>'trainingExport')::boolean, false) as training_export,
           settings->>'address' as address, settings->>'notes' as notes from tenant`)).rows[0];
      const row = ctx.userId ? (await db.query('select id, email, name, phone, locale, avatar_key, notify_guest_events from app_user where id = $1', [ctx.userId])).rows[0] : null;
      // notifyGuestEvents round-trips so the editor rehydrates the saved choice; an unrelated profile edit can never silently re-enable alerts.
      const user = row ? { id: row.id, email: row.email, name: row.name, phone: row.phone, locale: row.locale, notifyGuestEvents: row.notify_guest_events } : null;
      // A short-lived signed URL, never the raw storage key; null when no avatar has been uploaded.
      const avatarUrl = row?.avatar_key ? signUrl(app.cfg.JWT_SECRET, row.avatar_key, 300) : null;
      const unit = ctx.unitId ? (await db.query('select code, name from unit where id = $1', [ctx.unitId])).rows[0] : null;
      // The Resident screen reads unitVerified to choose the create form vs. the pending-verification banner.
      return { roles: ctx.roles, user, avatarUrl, unit, unitVerified: ctx.unitVerified, superadmin: ctx.superadmin, tenant: t };
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
      // Community-level (the surfaced name for the tenant) optional details. Empty string clears them.
      address: z.string().max(300).optional(),
      notes: z.string().max(2000).optional(),
    }),
    async handler({ ctx, db, body }) {
      const before = (await db.query('select ai_mode, default_locale, locales, terminology, plate_regions, settings from tenant')).rows[0];
      await db.query(
        `update tenant set ai_mode = coalesce($1, ai_mode), default_locale = coalesce($2, default_locale),
           locales = coalesce($3, locales), terminology = coalesce($4::jsonb, terminology),
           plate_regions = coalesce($5, plate_regions),
           settings = settings || jsonb_strip_nulls(jsonb_build_object('retentionDays', $6::int, 'trainingExport', $7::boolean, 'address', $8::text, 'notes', $9::text))`,
        [body.aiMode ?? null, body.defaultLocale ?? null, body.locales ?? null, body.terminology ? JSON.stringify(body.terminology) : null,
          body.plateRegions ?? null, body.retentionDays ?? null, body.trainingExport ?? null, body.address ?? null, body.notes ?? null]);
      await audit(db, ctx.tenantId, ctx.userId, 'tenant.update', 'tenant', before, body);
      return { ok: true };
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/api-keys', summary: 'Create a tenant (and optionally site) scoped API key; shown once', perm: 'users.edit',
    body: z.object({ name: z.string().trim().min(1).max(100), role: Role.default('attendant'), site: z.string().optional() }),
    async handler({ ctx, db, body }) {
      if (ctx.userId === null) throw new HttpError(403, 'forbidden', 'An API key cannot create API keys');
      if (body.site && body.role === 'admin') throw new HttpError(400, 'validation_failed', 'A key limited to one site cannot be an admin');
      let siteId: string | null = null;
      if (body.site) {
        siteId = (await db.query('select id from site where code = $1 and retired_at is null', [body.site])).rows[0]?.id;
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
    method: 'GET', path: '/v1/api-keys', summary: 'API keys (never the secret), including revoked ones', perm: 'users.edit',
    async handler({ db }) {
      return (await db.query(
        `select k.id, k.name, k.prefix, k.role, s.code as site, k.created_at, k.revoked_at
         from api_key k left join site s on s.id = k.site_id order by k.created_at desc`)).rows;
    },
  });

  defineRoute(app, {
    method: 'DELETE', path: '/v1/api-keys/:id', summary: 'Revoke an API key', perm: 'users.edit',
    async handler({ ctx, db, params }) {
      const r = await db.query('update api_key set revoked_at = now() where id = $1 and revoked_at is null returning prefix', [params.id]);
      if (!r.rowCount) throw new HttpError(404, 'api_key_not_found', 'No such active API key');
      await audit(db, ctx.tenantId, ctx.userId, 'api_key.revoke', `api_key:${r.rows[0].prefix}`, null, null);
      return { ok: true };
    },
  });

  defineRoute(app, {
    method: 'GET', path: '/v1/webhooks', summary: 'Webhook endpoints (never the signing secret)', perm: 'settings.edit',
    async handler({ db }) { return (await db.query('select id, url, events, active from webhook_endpoint order by url')).rows; },
  });

  defineRoute(app, {
    method: 'PATCH', path: '/v1/webhooks/:id', summary: 'Change a webhook endpoint: URL, events, or pause it', perm: 'settings.edit',
    body: z.object({ url: z.string().url().optional(), events: z.array(WebhookEvent).min(1).optional(), active: z.boolean().optional() }),
    async handler({ ctx, db, params, body }) {
      if (body.url) assertWebhookUrl(body.url);
      const r = await db.query('update webhook_endpoint set url = coalesce($2, url), events = coalesce($3, events), active = coalesce($4, active) where id = $1 returning id',
        [params.id, body.url ?? null, body.events ?? null, body.active ?? null]);
      if (!r.rowCount) throw new HttpError(404, 'webhook_not_found', 'No such webhook endpoint');
      await audit(db, ctx.tenantId, ctx.userId, 'webhook.update', `webhook:${params.id}`, null, body);
      return { ok: true };
    },
  });

  defineRoute(app, {
    method: 'DELETE', path: '/v1/webhooks/:id', summary: 'Delete a webhook endpoint', perm: 'settings.edit',
    async handler({ ctx, db, params }) {
      const r = await db.query('delete from webhook_endpoint where id = $1 returning id', [params.id]);
      if (!r.rowCount) throw new HttpError(404, 'webhook_not_found', 'No such webhook endpoint');
      await audit(db, ctx.tenantId, ctx.userId, 'webhook.delete', `webhook:${params.id}`, null, null);
      return { ok: true };
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/webhooks', summary: 'Register a webhook endpoint; returns the signing secret once', perm: 'settings.edit',
    body: z.object({
      url: z.string().url(),
      events: z.array(WebhookEvent).min(1),
    }),
    async handler({ ctx, db, body }) {
      assertWebhookUrl(body.url);
      const secret = `whsec_${randomBytes(24).toString('base64url')}`;
      const r = await db.query('insert into webhook_endpoint (tenant_id, url, secret, events) values ($1,$2,$3,$4) returning id',
        [ctx.tenantId, body.url, secret, body.events]);
      await audit(db, ctx.tenantId, ctx.userId, 'webhook.create', 'webhook_endpoint', null, body);
      return created({ id: r.rows[0].id, secret });
    },
  });
}
