import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { hashPassword } from '../auth.js';
import { externalAuthEnabled, localAuthEnabled } from '../config.js';
import { audit } from '../db.js';
import { HttpError, created, definePlatformRoute, definePublicRoute, defineRoute } from '../http.js';
import { provisionTenant, type Owner } from '../services/tenants.js';
import type { App } from '../server.js';

const StaffRole = z.enum(['admin', 'supervisor', 'attendant', 'auditor', 'resident']);

export function registerPeopleRoutes(app: App) {
  // What the sign-in/sign-up screens need to know before anyone is signed in.
  definePublicRoute(app, {
    method: 'GET', path: '/v1/config', summary: 'Public deployment settings (sign-up open?, auth mode)',
    handler: async () => ({ trialSignup: app.cfg.TRIAL_SIGNUP, auth: localAuthEnabled(app.cfg) ? (externalAuthEnabled(app.cfg) ? 'both' : 'local') : 'external' }),
  });

  // ---- who am I, across tenants (used by the app right after sign-in, before a tenant is chosen) ------------------
  definePublicRoute(app, {
    method: 'GET', path: '/v1/auth/memberships', summary: 'The signed-in identity and the tenants it belongs to',
    async handler({ req }) {
      const who = await app.identify(req);
      const [user, rows] = await Promise.all([
        app.db.raw((db) => db.query('select email, name, phone, locale from app_user where id = $1', [who.userId])),
        app.db.raw((db) => db.query('select * from user_memberships($1)', [who.userId])),
      ]);
      return {
        user: user.rows[0], superadmin: who.superadmin,
        memberships: rows.rows.map((m) => ({ slug: m.slug, name: m.name, role: m.role, unitId: m.unit_id, suspended: m.suspended })),
      };
    },
  });

  defineRoute(app, {
    method: 'PATCH', path: '/v1/me/profile', summary: 'Update my name, phone (for pass alerts) and language', perm: 'me',
    body: z.object({ name: z.string().max(100).optional(), phone: z.string().regex(/^\+[1-9]\d{7,14}$/).nullable().optional(), locale: z.string().max(10).optional() }),
    async handler({ ctx, db, body }) {
      if (!ctx.userId) throw new HttpError(400, 'user_required', 'API keys have no profile');
      await db.query(
        'update app_user set name = coalesce($2, name), phone = case when $3::boolean then $4 else phone end, locale = coalesce($5, locale) where id = $1',
        [ctx.userId, body.name ?? null, 'phone' in body, body.phone ?? null, body.locale ?? null]);
      return { ok: true };
    },
  });

  // ---- units ----------------------------------------------------------------------------------------------------
  defineRoute(app, {
    method: 'GET', path: '/v1/units', summary: 'Units (apartments/houses) and their residents', perm: 'read',
    async handler({ db }) {
      return (await db.query(
        `select u.code, u.name, s.code as site,
           coalesce((select json_agg(json_build_object('id', a.id, 'email', a.email, 'name', a.name) order by a.email)
             from membership m join app_user a on a.id = m.user_id where m.unit_id = u.id), '[]') as residents,
           (select p.status from pass p where p.unit_id = u.id and p.status in ('active','checked_in') limit 1) as pass_status
         from unit u left join site s on s.id = u.site_id order by u.code`)).rows;
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/units', summary: 'Create a unit', perm: 'users.edit',
    body: z.object({ code: z.string().min(1).max(30), name: z.string().min(1).max(100), site: z.string().optional() }),
    async handler({ ctx, db, body }) {
      let siteId: string | null = null;
      if (body.site) {
        siteId = (await db.query('select id from site where code = $1', [body.site])).rows[0]?.id;
        if (!siteId) throw new HttpError(404, 'site_not_found', `No site ${body.site}`);
      }
      const r = await db.query('insert into unit (tenant_id, site_id, code, name) values ($1,$2,$3,$4) on conflict (tenant_id, code) do nothing returning id',
        [ctx.tenantId, siteId, body.code, body.name]);
      if (!r.rowCount) throw new HttpError(409, 'unit_exists', `Unit ${body.code} already exists`);
      await audit(db, ctx.tenantId, ctx.userId, 'unit.create', `unit:${body.code}`, null, body);
      return created({ id: r.rows[0].id });
    },
  });

  // ---- people ---------------------------------------------------------------------------------------------------
  defineRoute(app, {
    method: 'GET', path: '/v1/users', summary: 'Members and pending invitations', perm: 'users.edit',
    async handler({ db }) {
      const members = (await db.query(
        `select a.id, a.email, a.name, a.phone, m.role, un.code as unit from membership m join app_user a on a.id = m.user_id
         left join unit un on un.id = m.unit_id order by m.role, a.email`)).rows;
      const invites = (await db.query(
        `select i.email, i.role, un.code as unit, i.created_at from membership_invite i left join unit un on un.id = i.unit_id order by i.email`)).rows;
      return { members, invites };
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/users', summary: 'Add a person. Local auth returns a one-time password; external auth sends an invitation by email', perm: 'users.edit',
    body: z.object({ email: z.string().email(), name: z.string().optional(), role: StaffRole, unit: z.string().optional() }),
    async handler({ ctx, db, body }) {
      const email = body.email.toLowerCase();
      let unitId: string | null = null;
      if (body.role === 'resident') {
        unitId = (await db.query('select id from unit where code = $1', [body.unit ?? ''])).rows[0]?.id ?? null;
        if (!unitId) throw new HttpError(400, 'unit_required', 'A resident must be assigned to an existing unit');
      }
      const existing = (await db.query('select id from app_user where email = $1', [email])).rows[0];
      let userId: string | undefined = existing?.id;
      let temp: string | undefined;

      if (!userId && localAuthEnabled(app.cfg)) {
        temp = randomBytes(9).toString('base64url');
        userId = (await db.query('insert into app_user (email, name, password_hash) values ($1,$2,$3) returning id', [email, body.name ?? null, await hashPassword(temp)])).rows[0].id;
      }
      if (userId) {
        const r = await db.query('insert into membership (tenant_id, user_id, role, unit_id) values ($1,$2,$3,$4) on conflict do nothing', [ctx.tenantId, userId, body.role, unitId]);
        if (!r.rowCount) throw new HttpError(409, 'already_member', 'That person already belongs to this tenant');
        await audit(db, ctx.tenantId, ctx.userId, 'user.add', 'membership', null, { email, role: body.role, unit: body.unit });
        return created({ userId, ...(temp ? { temporaryPassword: temp } : {}) });
      }
      // External identity: the invitation is claimed automatically the first time that email signs in.
      const r = await db.query(
        'insert into membership_invite (tenant_id, email, role, unit_id, invited_by) values ($1,$2,$3,$4,$5) on conflict (tenant_id, email) do update set role = excluded.role, unit_id = excluded.unit_id',
        [ctx.tenantId, email, body.role, unitId, ctx.userId]);
      await audit(db, ctx.tenantId, ctx.userId, 'user.invite', 'membership_invite', null, { email, role: body.role, unit: body.unit });
      return created({ invited: true, email, claimed: r.rowCount === 1 });
    },
  });

  defineRoute(app, {
    method: 'PATCH', path: '/v1/users/:id', summary: 'Change a member role or unit', perm: 'users.edit',
    body: z.object({ role: z.enum(['owner', 'admin', 'supervisor', 'attendant', 'auditor', 'resident']).optional(), unit: z.string().nullable().optional() }),
    async handler({ ctx, db, params, body }) {
      const cur = (await db.query('select role, unit_id from membership where user_id = $1', [params.id])).rows[0];
      if (!cur) throw new HttpError(404, 'member_not_found', 'No such member');
      const role = body.role ?? cur.role;
      let unitId = cur.unit_id as string | null;
      if (body.unit !== undefined) {
        unitId = body.unit === null ? null : (await db.query('select id from unit where code = $1', [body.unit])).rows[0]?.id ?? null;
        if (body.unit !== null && !unitId) throw new HttpError(404, 'unit_not_found', `No unit ${body.unit}`);
      }
      if (role === 'resident' && !unitId) throw new HttpError(400, 'unit_required', 'A resident must be assigned to a unit');
      if (role !== 'resident' && body.role) unitId = body.unit === undefined ? null : unitId;
      if (cur.role === 'owner' && role !== 'owner') await assertAnotherOwner(db, params.id!);
      await db.query('update membership set role = $2, unit_id = $3 where user_id = $1', [params.id, role, unitId]);
      await audit(db, ctx.tenantId, ctx.userId, 'user.update', `user:${params.id}`, cur, { role, unitId });
      return { ok: true };
    },
  });

  defineRoute(app, {
    method: 'DELETE', path: '/v1/users/:id', summary: 'Remove a member from the tenant', perm: 'users.edit',
    async handler({ ctx, db, params }) {
      const cur = (await db.query('select role from membership where user_id = $1', [params.id])).rows[0];
      if (!cur) throw new HttpError(404, 'member_not_found', 'No such member');
      if (cur.role === 'owner') await assertAnotherOwner(db, params.id!);
      await db.query('delete from membership where user_id = $1', [params.id]);
      await audit(db, ctx.tenantId, ctx.userId, 'user.remove', `user:${params.id}`, cur, null);
      return { ok: true };
    },
  });

  // ---- platform (super admin) -----------------------------------------------------------------------------------
  definePlatformRoute(app, {
    method: 'GET', path: '/v1/platform/tenants', summary: 'All tenants with usage counts',
    handler: async () => (await app.db.raw((db) => db.query('select * from platform_tenants()'))).rows,
  });

  // Closed preview: platform admins create organisations for invited testers (public signup is off).
  definePlatformRoute(app, {
    method: 'POST', path: '/v1/platform/tenants', summary: 'Create an organisation and invite its owner (works while public sign-up is closed)',
    body: z.object({ organisation: z.string().min(2).max(100), country: z.string().length(2).toUpperCase(), ownerEmail: z.string().email(), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}$/).optional(), ownerName: z.string().optional() }),
    async handler({ body }) {
      const email = body.ownerEmail.toLowerCase();
      const known = (await app.db.raw((db) => db.query('select id from app_user where email = $1', [email]))).rows[0];
      let owner: Owner; let temp: string | undefined;
      if (known) owner = { kind: 'user', userId: known.id };
      else if (localAuthEnabled(app.cfg)) { temp = randomBytes(9).toString('base64url'); owner = { kind: 'new_local_user', email, name: body.ownerName, password: temp }; }
      else if (externalAuthEnabled(app.cfg)) owner = { kind: 'invite', email }; // joins when they sign in with this email
      else throw new HttpError(500, 'no_auth', 'No sign-in method is configured');
      const t = await provisionTenant(app, { organisation: body.organisation, country: body.country, slug: body.slug, owner });
      return created({ slug: t.slug, ownerEmail: email, ...(temp ? { temporaryPassword: temp } : {}), ...(owner.kind === 'invite' ? { invited: true } : {}) });
    },
  });

  definePlatformRoute(app, {
    method: 'POST', path: '/v1/platform/tenants/:slug/suspend', summary: 'Suspend a tenant (blocks all its users and API keys)',
    body: z.object({ reason: z.string().min(3).max(300) }),
    async handler({ req, body, userId }) {
      const { slug } = req.params as { slug: string };
      const ok = (await app.db.raw((db) => db.query('select platform_set_suspended($1, true, $2, $3) as ok', [slug, body.reason, userId]))).rows[0].ok;
      if (!ok) throw new HttpError(404, 'tenant_not_found', `No tenant ${slug}`);
      return { ok: true };
    },
  });

  definePlatformRoute(app, {
    method: 'POST', path: '/v1/platform/tenants/:slug/resume', summary: 'Lift a suspension',
    async handler({ req, userId }) {
      const { slug } = req.params as { slug: string };
      const ok = (await app.db.raw((db) => db.query('select platform_set_suspended($1, false, null, $2) as ok', [slug, userId]))).rows[0].ok;
      if (!ok) throw new HttpError(404, 'tenant_not_found', `No tenant ${slug}`);
      return { ok: true };
    },
  });
}

/** A tenant must always keep at least one owner. */
async function assertAnotherOwner(db: import('../db.js').Db, leaving: string) {
  const n = (await db.query("select count(*)::int as n from membership where role = 'owner' and user_id <> $1", [leaving])).rows[0].n;
  if (!n) throw new HttpError(409, 'last_owner', 'A tenant needs at least one owner');
}
