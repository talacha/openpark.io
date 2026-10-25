import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ROLES, can } from '../auth.js';
import { externalAuthEnabled, localAuthEnabled } from '../config.js';
import { audit } from '../db.js';
import { HttpError, created, definePlatformRoute, definePublicRoute, defineRoute, boolQuery } from '../http.js';
import { addPerson } from '../services/people.js';
import { cancelUnusedPassesOfHost } from '../services/passes.js';
import { applyUnits, exportUnits, parseUnitsDoc, previewUnits } from '../services/units.js';
import { applyUsers, exportUsers, parseUsersDoc, previewUsers, rollbackUsers, type UsersRollback } from '../services/usersimport.js';
import { locateJsonError } from '../jsonpos.js';
import { imageAsset, imageStorageKey, parseImageStorageKey } from '../images.js';
import { provisionTenant, type Owner } from '../services/tenants.js';
import type { App } from '../server.js';

const RoleList = z.array(z.enum(ROLES)).min(1).transform((r) => [...new Set(r)].sort((a, b) => ROLES.indexOf(a) - ROLES.indexOf(b)));

export function registerPeopleRoutes(app: App) {
  // What the sign-in/sign-up screens need to know before anyone is signed in.
  definePublicRoute(app, {
    method: 'GET', path: '/v1/config', summary: 'Public deployment settings (sign-up open?, auth mode)',
    handler: async () => ({ trialSignup: app.cfg.TRIAL_SIGNUP, realtime: app.cfg.SSE_ENABLED ? 'sse' : 'poll', auth: localAuthEnabled(app.cfg) ? (externalAuthEnabled(app.cfg) ? 'both' : 'local') : 'external' }),
  });

  // ---- invitations addressed to me: accepted by the person, never forced on them ------------------------------------------
  definePublicRoute(app, {
    method: 'GET', path: '/v1/auth/invitations', summary: 'Invitations to join properties, addressed to the signed-in email',
    async handler({ req }) {
      const who = await app.identify(req);
      if (!who.email) return [];
      return (await app.db.raw((db) => db.query('select slug, name, roles, unit, superadmin from my_invites($1)', [who.email]))).rows;
    },
  });

  definePublicRoute(app, {
    method: 'POST', path: '/v1/auth/invitations/:slug/accept', summary: 'Accept an invitation to a property',
    async handler({ req }) {
      const who = await app.identify(req);
      const { slug } = req.params as { slug: string };
      const ok = await app.db.raw(async (db) => {
        const t = (await db.query('select tenant_id from my_invites($1) where slug = $2', [who.email ?? '', slug])).rows[0];
        if (!t) return false;
        return (await db.query('select accept_invite($1, $2, $3) as ok', [who.userId, who.email, t.tenant_id])).rows[0].ok as boolean;
      });
      if (!ok) throw new HttpError(404, 'invite_not_found', 'No such pending invitation');
      return { ok: true };
    },
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
        memberships: rows.rows.map((m) => ({ slug: m.slug, name: m.name, roles: m.roles, unitId: m.unit_id, suspended: m.suspended })),
      };
    },
  });

  defineRoute(app, {
    method: 'PATCH', path: '/v1/me/profile', summary: 'Update my name, phone (for pass alerts), language and guest-alert opt-in', perm: 'me',
    body: z.object({ name: z.string().max(100).optional(), phone: z.string().regex(/^\+[1-9]\d{7,14}$/).nullable().optional(), locale: z.string().max(10).optional(), notifyGuestEvents: z.boolean().optional() }),
    async handler({ ctx, db, body }) {
      if (!ctx.userId) throw new HttpError(400, 'user_required', 'API keys have no profile');
      await db.query(
        'update app_user set name = coalesce($2, name), phone = case when $3::boolean then $4 else phone end, locale = coalesce($5, locale), notify_guest_events = coalesce($6, notify_guest_events) where id = $1',
        [ctx.userId, body.name ?? null, 'phone' in body, body.phone ?? null, body.locale ?? null, body.notifyGuestEvents ?? null]);
      return { ok: true };
    },
  });

  // A resident's profile picture: base64 JSON upload (same transport as plate crops). The server optimises it to
  // WebP and stores it in Postgres, keyed by email; GET /v1/me returns a short-lived signed URL, never the key.
  defineRoute(app, {
    method: 'POST', path: '/v1/me/avatar', summary: 'Upload my profile picture (JPEG, PNG or WebP, up to 5 MiB)', perm: 'me', replaySafe: true,
    body: z.object({ contentType: z.enum(['image/webp', 'image/jpeg', 'image/png']), dataBase64: z.string().min(1) }),
    async handler({ app, ctx, db, body }) {
      if (!ctx.userId) throw new HttpError(400, 'user_required', 'API keys have no profile');
      const user = (await db.query('select email, avatar_key from app_user where id = $1', [ctx.userId])).rows[0];
      if (!user) throw new HttpError(404, 'user_not_found', 'No such user');
      let buf: Buffer;
      try { buf = Buffer.from(body.dataBase64, 'base64'); } catch { throw new HttpError(400, 'avatar_invalid', 'The image could not be decoded'); }
      if (buf.length === 0 || buf.length > 5 * 1024 * 1024) throw new HttpError(400, 'avatar_invalid', 'The image must be 5 MiB or smaller');
      if (!signatureMatches(body.contentType, buf)) throw new HttpError(400, 'avatar_invalid', 'The image data does not match its declared type');

      const asset = await imageAsset(db, ctx.tenantId, { type: 'avatar', subject: user.email }, buf);
      if (!asset) throw new HttpError(500, 'avatar_failed', 'The image could not be stored');
      const key = imageStorageKey(ctx.tenantId, asset.key);
      await db.query('update app_user set avatar_key = $2 where id = $1', [ctx.userId, key]);
      // A picture stored before the move to Postgres is an object-storage key; remove it once the new row is live.
      if (user.avatar_key && !parseImageStorageKey(user.avatar_key)) {
        try { await app.storage.delete(user.avatar_key); } catch (e) { app.log.warn({ err: (e as Error).message, key: user.avatar_key }, 'orphaned avatar delete failed'); }
      }
      return { ok: true };
    },
  });

  // ---- units ----------------------------------------------------------------------------------------------------
  defineRoute(app, {
    method: 'GET', path: '/v1/units', summary: 'Units (apartments/houses) and their residents', perm: 'read',
    query: z.object({ site: z.string().optional() }),
    async handler({ ctx, db, query: q }) {
      // A human attendant working a gate passes ?site=CODE to narrow the host dropdown to that site's units PLUS
      // community-wide units with no site (unit.site_id is nulled when a site is retired), so legitimate units stay
      // nameable. The ctx.siteId scope (an API key limited to one site) still applies on top.
      const rows = (await db.query(
        `select u.code, u.name, s.code as site, u.floor, u.note,
           coalesce((select json_agg(json_build_object('id', a.id, 'email', a.email, 'name', a.name) order by a.email)
             from membership m join app_user a on a.id = m.user_id where m.unit_id = u.id), '[]') as residents,
           (select p.status from pass p where p.unit_id = u.id and p.status in ('active','checked_in') limit 1) as pass_status
         from unit u left join site s on s.id = u.site_id
         where ($1::uuid is null or u.site_id = $1)
           and ($2::text is null or s.code = $2 or u.site_id is null)
         order by u.code limit 500`, [ctx.siteId, q.site ?? null])).rows;
      // Who lives where is for the people who manage people; an attendant sees the units only.
      return can(ctx, 'users.edit') ? rows : rows.map((r) => ({ ...r, residents: [] }));
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/units', summary: 'Create a unit', perm: 'users.edit', replaySafe: true,
    body: z.object({ code: z.string().trim().min(1).max(30), name: z.string().trim().min(1).max(100), site: z.string().optional(), floor: z.number().int().min(-20).max(300).nullable().optional(), note: z.string().max(500).nullable().optional() }),
    async handler({ ctx, db, body }) {
      let siteId: string | null = null;
      if (body.site) {
        siteId = (await db.query('select id from site where code = $1 and retired_at is null', [body.site])).rows[0]?.id;
        if (!siteId) throw new HttpError(404, 'site_not_found', `No site ${body.site}`);
      }
      const r = await db.query('insert into unit (tenant_id, site_id, code, name, floor, note) values ($1,$2,$3,$4,$5,$6) on conflict (tenant_id, code) do nothing returning id',
        [ctx.tenantId, siteId, body.code, body.name, body.floor ?? null, body.note ?? null]);
      if (!r.rowCount) throw new HttpError(409, 'unit_exists', `Unit ${body.code} already exists`);
      await audit(db, ctx.tenantId, ctx.userId, 'unit.create', `unit:${body.code}`, null, body);
      return created({ id: r.rows[0].id });
    },
  });

  defineRoute(app, {
    method: 'PATCH', path: '/v1/units/:code', summary: 'Edit a unit: name, site, floor, note (the code is its identity; to change it, create a new unit)', perm: 'users.edit',
    body: z.object({ name: z.string().min(1).max(100).optional(), site: z.string().nullable().optional(), floor: z.number().int().min(-20).max(300).nullable().optional(), note: z.string().max(500).nullable().optional() }),
    async handler({ ctx, db, params, body }) {
      const cur = (await db.query('select id, name, site_id, floor, note from unit where code = $1', [params.code])).rows[0];
      if (!cur) throw new HttpError(404, 'unit_not_found', `No unit ${params.code}`);
      let siteId = cur.site_id as string | null;
      if (body.site !== undefined) {
        siteId = body.site === null ? null : (await db.query('select id from site where code = $1 and retired_at is null', [body.site])).rows[0]?.id ?? null;
        if (body.site !== null && !siteId) throw new HttpError(404, 'site_not_found', `No site ${body.site}`);
      }
      await db.query('update unit set name = $2, site_id = $3, floor = $4, note = $5 where id = $1',
        [cur.id, body.name ?? cur.name, siteId, body.floor === undefined ? cur.floor : body.floor, body.note === undefined ? cur.note : body.note]);
      if (siteId !== cur.site_id) {
        // An unused pass was issued for the old gate: move it to the new site, or cancel it when the unit has no site.
        if (siteId) await db.query("update pass set site_id = $2 where unit_id = $1 and status = 'active'", [cur.id, siteId]);
        else await db.query("update pass set status = 'cancelled', cancelled_at = now() where unit_id = $1 and status = 'active'", [cur.id]);
      }
      await audit(db, ctx.tenantId, ctx.userId, 'unit.update', `unit:${params.code}`, cur, body);
      return { ok: true };
    },
  });

  defineRoute(app, {
    method: 'DELETE', path: '/v1/units/:code', summary: 'Delete a unit that has no residents and no guest passes', perm: 'users.edit',
    async handler({ ctx, db, params }) {
      const cur = (await db.query('select id from unit where code = $1', [params.code])).rows[0];
      if (!cur) throw new HttpError(404, 'unit_not_found', `No unit ${params.code}`);
      const used = (await db.query(
        `select (select count(*)::int from membership where unit_id = $1) + (select count(*)::int from membership_invite where unit_id = $1)
              + (select count(*)::int from pass where unit_id = $1) as n`, [cur.id])).rows[0].n;
      if (used) throw new HttpError(409, 'unit_in_use', 'This unit has residents, invitations or guest passes');
      await db.query('delete from unit where id = $1', [cur.id]);
      await audit(db, ctx.tenantId, ctx.userId, 'unit.delete', `unit:${params.code}`, cur, null);
      return { ok: true };
    },
  });

  defineRoute(app, {
    method: 'GET', path: '/v1/units/export', summary: 'Units (and their residents) as JSON', perm: 'users.edit',
    handler: async ({ ctx, db }) => exportUnits(db, ctx.tenantSlug, app.now()),
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/units/import', summary: 'Validate a units file and preview the changes; returns a job', perm: 'users.edit', replaySafe: true,
    query: z.object({ mode: z.enum(['merge', 'replace']).default('merge'), dryRun: boolQuery() }),
    body: z.record(z.unknown()),
    async handler({ ctx, db, query, body }) {
      const doc = parseUnitsDoc(body, locateJsonError);
      const diff = await previewUnits(db, doc, query.mode);
      const job = (await db.query(
        "insert into inventory_import (tenant_id, kind, mode, doc, diff, created_by) values ($1,'units',$2,$3,$4,$5) returning id",
        [ctx.tenantId, query.mode, JSON.stringify(doc), JSON.stringify({ ...diff, dryRun: query.dryRun }), ctx.userId])).rows[0];
      const summary = { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, conflicts: diff.conflicts.length, residents: diff.residentsToAdd.length, errors: diff.errors.length };
      return created({ job: job.id, mode: query.mode, dryRun: query.dryRun, summary, diff });
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/units/import/:job/apply', summary: 'Apply a previewed units import', perm: 'users.edit', idempotent: true,
    async handler({ ctx, db, params }) {
      const job = (await db.query("select * from inventory_import where id = $1 and kind = 'units' for update", [params.job])).rows[0];
      if (!job) throw new HttpError(404, 'job_not_found', 'No such import job');
      if (job.diff.dryRun) throw new HttpError(409, 'dry_run', 'This job was a dry run; submit the import again without dryRun');
      if (job.status !== 'previewed') throw new HttpError(409, 'not_previewed', `Job is ${job.status}`);
      // Live state may have moved since the preview, so the diff is recomputed and re-checked inside applyUnits.
      const result = await applyUnits(app, db, ctx.tenantId, ctx.userId, parseUnitsDoc(job.doc, locateJsonError), job.mode);
      await db.query("update inventory_import set status = 'applied', applied_at = now() where id = $1", [job.id]);
      return { job: job.id, applied: result };
    },
  });

  // ---- people ---------------------------------------------------------------------------------------------------
  defineRoute(app, {
    method: 'GET', path: '/v1/users', summary: 'Members and pending invitations', perm: 'users.edit',
    async handler({ db }) {
      const members = (await db.query(
        `select a.id, a.email, a.name, a.phone, m.roles, m.unit_verified, a.is_superadmin as superadmin, un.code as unit from membership m join app_user a on a.id = m.user_id
         left join unit un on un.id = m.unit_id order by a.is_superadmin desc, cardinality(m.roles) desc, a.email`)).rows;
      const invites = (await db.query(
        `select i.email, i.roles, i.superadmin, un.code as unit, i.created_at from membership_invite i left join unit un on un.id = i.unit_id order by i.email`)).rows;
      return { members, invites };
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/users', summary: 'Add a person with one or more roles. Local auth returns a one-time password; external auth sends an invitation by email', perm: 'users.edit', replaySafe: true,
    body: z.object({ email: z.string().email().max(254), name: z.string().trim().max(100).optional(), roles: RoleList, unit: z.string().optional(), superadmin: z.boolean().optional() }),
    async handler({ ctx, db, body }) {
      const email = body.email.toLowerCase();
      if (body.superadmin && !ctx.superadmin) throw new HttpError(403, 'forbidden', 'Only a Super Admin can grant Super Admin access');
      let unitId: string | null = null;
      if (body.roles.includes('resident')) {
        unitId = (await db.query('select id from unit where code = $1', [body.unit ?? ''])).rows[0]?.id ?? null;
        if (!unitId) throw new HttpError(400, 'unit_required', 'A resident must be assigned to an existing unit');
      }
      // An admin adding a resident vouches for the unit grant, so it is verified at creation (they can issue passes at once).
      const r = await addPerson(app, db, ctx.tenantId, ctx.userId, { email, name: body.name, roles: body.roles, unitId, superadmin: !!body.superadmin, unitVerified: true });
      await audit(db, ctx.tenantId, ctx.userId, r.invited ? 'user.invite' : 'user.add', r.invited ? 'membership_invite' : 'membership', null, { email, roles: body.roles, unit: body.unit });
      if (body.superadmin && !r.invited) await db.query('update app_user set is_superadmin = true where id = $1', [r.userId]);
      // An invited person has no account yet: the flag waits on the invitation and is applied when they sign in.
      return created(r.invited ? { invited: true, email } : { userId: r.userId, ...(r.temporaryPassword ? { temporaryPassword: r.temporaryPassword } : {}) });
    },
  });

  defineRoute(app, {
    method: 'PATCH', path: '/v1/users/:id', summary: "Change a member's roles or unit; only a Super Admin can grant or remove Super Admin", perm: 'users.edit',
    body: z.object({ roles: RoleList.optional(), unit: z.string().nullable().optional(), superadmin: z.boolean().optional() }),
    async handler({ ctx, db, params, body }) {
      const cur = (await db.query('select roles, unit_id from membership where user_id = $1', [params.id])).rows[0];
      if (!cur) throw new HttpError(404, 'member_not_found', 'No such member');
      const roles: string[] = body.roles ?? cur.roles;
      let unitId = cur.unit_id as string | null;
      if (body.unit !== undefined) {
        unitId = body.unit === null ? null : (await db.query('select id from unit where code = $1', [body.unit])).rows[0]?.id ?? null;
        if (body.unit !== null && !unitId) throw new HttpError(404, 'unit_not_found', `No unit ${body.unit}`);
      }
      if (roles.includes('resident') && !unitId) throw new HttpError(400, 'unit_required', 'A resident must be assigned to a unit');
      if (!roles.includes('resident')) unitId = null;
      if (cur.roles.includes('admin') && !roles.includes('admin')) await assertAnotherAdmin(db, params.id!);
      if (body.superadmin !== undefined) {
        if (!ctx.superadmin) throw new HttpError(403, 'forbidden', 'Only a Super Admin can change Super Admin access');
        await db.query('update app_user set is_superadmin = $2 where id = $1', [params.id, body.superadmin]);
      }
      await db.query('update membership set roles = $2, unit_id = $3 where user_id = $1', [params.id, roles, unitId]);
      if (cur.unit_id && (unitId !== cur.unit_id)) await cancelUnusedPassesOfHost(db, params.id!); // their unit's passes were theirs
      await audit(db, ctx.tenantId, ctx.userId, 'user.update', `user:${params.id}`, cur, { roles, unitId, superadmin: body.superadmin });
      return { ok: true };
    },
  });

  defineRoute(app, {
    method: 'DELETE', path: '/v1/users/:id', summary: 'Remove a member from the tenant', perm: 'users.edit',
    async handler({ ctx, db, params }) {
      const cur = (await db.query('select roles from membership where user_id = $1', [params.id])).rows[0];
      if (!cur) throw new HttpError(404, 'member_not_found', 'No such member');
      if (cur.roles.includes('admin')) await assertAnotherAdmin(db, params.id!);
      await db.query('delete from membership where user_id = $1', [params.id]);
      await cancelUnusedPassesOfHost(db, params.id!);
      await audit(db, ctx.tenantId, ctx.userId, 'user.remove', `user:${params.id}`, cur, null);
      return { ok: true };
    },
  });

  defineRoute(app, {
    method: 'PATCH', path: '/v1/users/:id/verify', summary: "Verify a resident's unit access so they can issue guest passes", perm: 'users.edit', idempotent: true,
    async handler({ ctx, db, params }) {
      const cur = (await db.query('select roles, unit_verified from membership where user_id = $1', [params.id])).rows[0];
      if (!cur) throw new HttpError(404, 'member_not_found', 'No such member');
      if (!cur.roles.includes('resident')) throw new HttpError(409, 'not_resident', 'Only a resident holds a unit grant to verify');
      await db.query('update membership set unit_verified = true where user_id = $1', [params.id]);
      await audit(db, ctx.tenantId, ctx.userId, 'user.verify_unit', `user:${params.id}`, { unit_verified: cur.unit_verified }, { unit_verified: true });
      return { ok: true };
    },
  });

  // ---- bulk users: validate -> diff -> preview -> apply. Export/diff carry NO secrets; created rows take the invite path.
  defineRoute(app, {
    method: 'GET', path: '/v1/users/export', summary: 'Members and invitations (email, name, roles, unit, unitVerified) as JSON — no secrets', perm: 'users.edit',
    handler: async ({ ctx, db }) => exportUsers(db, ctx.tenantSlug, app.now()),
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/users/import', summary: 'Validate a users file and preview the changes; returns a job', perm: 'users.edit', replaySafe: true,
    query: z.object({ dryRun: boolQuery() }),
    body: z.record(z.unknown()),
    async handler({ ctx, db, query, body }) {
      const doc = parseUsersDoc(body, locateJsonError);
      const diff = await previewUsers(db, doc);
      const job = (await db.query(
        "insert into inventory_import (tenant_id, kind, mode, doc, diff, created_by) values ($1,'users','merge',$2,$3,$4) returning id",
        [ctx.tenantId, JSON.stringify(doc), JSON.stringify({ ...diff, dryRun: query.dryRun }), ctx.userId])).rows[0];
      const summary = { added: diff.added.length, changed: diff.changed.length, skipped: diff.skipped.length, conflicts: diff.conflicts.length, errors: diff.errors.length };
      return created({ job: job.id, dryRun: query.dryRun, summary, diff });
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/users/import/:job/apply', summary: 'Apply a previewed users import (invite path only — no plaintext OTP)', perm: 'users.edit', idempotent: true,
    async handler({ ctx, db, params }) {
      const job = (await db.query("select * from inventory_import where id = $1 and kind = 'users' for update", [params.job])).rows[0];
      if (!job) throw new HttpError(404, 'job_not_found', 'No such import job');
      if (job.diff.dryRun) throw new HttpError(409, 'dry_run', 'This job was a dry run; submit the import again without dryRun');
      if (job.status !== 'previewed') throw new HttpError(409, 'not_previewed', `Job is ${job.status}`);
      const { rollback, ...applied } = await applyUsers(app, db, ctx.tenantId, ctx.userId, parseUsersDoc(job.doc, locateJsonError));
      // Persist exactly what the job created/overwrote, so rollback restores that state instead of deleting by email.
      await db.query("update inventory_import set status = 'applied', snapshot = $2, applied_at = now() where id = $1", [job.id, JSON.stringify(rollback)]);
      return { job: job.id, applied };
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/users/import/:job/rollback', summary: 'Undo a users import: withdraw invitations it created, restore ones it overwrote', perm: 'users.edit', idempotent: true,
    async handler({ ctx, db, params }) {
      const job = (await db.query("select * from inventory_import where id = $1 and kind = 'users' for update", [params.job])).rows[0];
      if (!job) throw new HttpError(404, 'job_not_found', 'No such import job');
      if (job.status !== 'applied') throw new HttpError(409, 'not_applied', `Job is ${job.status}`);
      // Rollback is restorative: it only touches invitations this job created or overwrote (captured in snapshot at
      // apply time), never every uploaded email. A legacy job with no snapshot has nothing safe to undo.
      const rb = (job.snapshot ?? { created: [], restored: {}, members: [] }) as UsersRollback;
      const rolledBack = await rollbackUsers(db, ctx.tenantId, ctx.userId, rb);
      await db.query("update inventory_import set status = 'rolled_back' where id = $1", [job.id]);
      return { job: job.id, rolledBack };
    },
  });

  defineRoute(app, {
    method: 'PATCH', path: '/v1/invites/:email', summary: "Change a pending invitation's roles or unit", perm: 'users.edit',
    body: z.object({ roles: RoleList, unit: z.string().nullable().optional(), superadmin: z.boolean().optional() }),
    async handler({ ctx, db, params, body }) {
      const email = params.email!.toLowerCase();
      if (body.superadmin !== undefined && !ctx.superadmin) throw new HttpError(403, 'forbidden', 'Only a Super Admin can change Super Admin access');
      const cur = (await db.query('select roles, unit_id from membership_invite where email = $1', [email])).rows[0];
      if (!cur) throw new HttpError(404, 'invite_not_found', 'No such pending invitation');
      let unitId: string | null = null;
      if (body.roles.includes('resident')) {
        const code = body.unit === undefined ? null : body.unit;
        unitId = code === null ? cur.unit_id : (await db.query('select id from unit where code = $1', [code])).rows[0]?.id ?? null;
        if (!unitId) throw new HttpError(400, 'unit_required', 'A resident must be assigned to an existing unit');
      }
      await db.query('update membership_invite set roles = $2, unit_id = $3, superadmin = coalesce($4, superadmin) where email = $1', [email, body.roles, unitId, body.superadmin ?? null]);
      await audit(db, ctx.tenantId, ctx.userId, 'user.invite_update', `invite:${email}`, cur, { roles: body.roles, unitId });
      return { ok: true };
    },
  });

  defineRoute(app, {
    method: 'DELETE', path: '/v1/invites/:email', summary: 'Withdraw a pending invitation', perm: 'users.edit',
    async handler({ ctx, db, params }) {
      const email = params.email!.toLowerCase();
      const gone = await db.query('delete from membership_invite where email = $1 returning roles', [email]);
      if (!gone.rowCount) throw new HttpError(404, 'invite_not_found', 'No such pending invitation');
      await audit(db, ctx.tenantId, ctx.userId, 'user.invite_remove', `invite:${email}`, gone.rows[0], null);
      return { ok: true };
    },
  });

  // ---- platform (super admin) -----------------------------------------------------------------------------------
  definePlatformRoute(app, {
    method: 'GET', path: '/v1/platform/tenants', summary: 'All tenants with usage counts',
    handler: async () => (await app.db.raw((db) => db.query('select * from platform_tenants()'))).rows,
  });

  // A Super Admin assigns people to any property, with the unit of that property.
  definePlatformRoute(app, {
    method: 'GET', path: '/v1/platform/tenants/:slug/units', summary: "A property's units (for assigning people)",
    async handler({ req }) {
      const { slug } = req.params as { slug: string };
      const t = (await app.db.raw((db) => db.query('select id from tenant_by_slug($1)', [slug]))).rows[0];
      if (!t) throw new HttpError(404, 'tenant_not_found', `No tenant ${slug}`);
      return (await app.db.withTenant(t.id, (db) => db.query('select code, name from unit order by code'))).rows;
    },
  });

  definePlatformRoute(app, {
    method: 'POST', path: '/v1/platform/tenants/:slug/members', summary: 'Add a person to any property with roles and (for residents) a unit of that property',
    replaySafe: true,
    body: z.object({ email: z.string().email().max(254), name: z.string().trim().max(100).optional(), roles: RoleList, unit: z.string().optional(), superadmin: z.boolean().optional() }),
    async handler({ req, body, userId }) {
      const { slug } = req.params as { slug: string };
      const t = (await app.db.raw((db) => db.query('select id from tenant_by_slug($1)', [slug]))).rows[0];
      if (!t) throw new HttpError(404, 'tenant_not_found', `No tenant ${slug}`);
      return created(await app.db.withTenant(t.id, async (db) => {
        let unitId: string | null = null;
        if (body.roles.includes('resident')) {
          unitId = (await db.query('select id from unit where code = $1', [body.unit ?? ''])).rows[0]?.id ?? null;
          if (!unitId) throw new HttpError(400, 'unit_required', 'A resident must be assigned to an existing unit');
        }
        const r = await addPerson(app, db, t.id, userId, { email: body.email.toLowerCase(), name: body.name, roles: body.roles, unitId, superadmin: !!body.superadmin, direct: true, unitVerified: true });
        if (body.superadmin && r.userId) await db.query('update app_user set is_superadmin = true where id = $1', [r.userId]);
        await audit(db, t.id, userId, r.invited ? 'user.invite' : 'user.add', r.invited ? 'membership_invite' : 'membership', null, { email: body.email, roles: body.roles, unit: body.unit, by: 'platform' });
        return r.invited ? { invited: true, email: body.email } : { userId: r.userId, ...(r.temporaryPassword ? { temporaryPassword: r.temporaryPassword } : {}) };
      }));
    },
  });

  // Closed preview: platform admins create organisations for invited testers (public signup is off).
  definePlatformRoute(app, {
    method: 'POST', path: '/v1/platform/tenants', summary: 'Create an organisation and invite its owner (works while public sign-up is closed)',
    replaySafe: true,
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

/** Cheap magic-byte check so a declared MIME cannot smuggle a mismatched (or non-image) payload. */
function signatureMatches(contentType: 'image/png' | 'image/jpeg' | 'image/webp', buf: Buffer): boolean {
  if (contentType === 'image/png') return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (contentType === 'image/jpeg') return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  // WebP: 'RIFF' .... 'WEBP'
  return buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
}

/** A property must always keep at least one admin, or nobody could configure it. */
async function assertAnotherAdmin(db: import('../db.js').Db, leaving: string) {
  // Lock the admins first: two people demoting each other at once must not both pass the count below.
  await db.query("select user_id from membership where 'admin' = any(roles) order by user_id for update");
  const n = (await db.query("select count(*)::int as n from membership where 'admin' = any(roles) and user_id <> $1", [leaving])).rows[0].n;
  if (!n) throw new HttpError(409, 'last_admin', 'A property needs at least one admin');
}
