import { randomBytes } from 'node:crypto';
import { hashPassword } from '../auth.js';
import { localAuthEnabled } from '../config.js';
import type { Db } from '../db.js';
import { HttpError } from '../http.js';
import type { App } from '../server.js';

export interface AddedPerson { userId?: string; temporaryPassword?: string; invited?: boolean }

/**
 * Put someone in the property with one or more roles. An existing account joins straight away; otherwise local auth creates the
 * account (returning a one-time password) and external auth records an invitation that is claimed at first sign-in.
 */
export async function addPerson(app: App, db: Db, tenantId: string, invitedBy: string | null,
  p: { email: string; name?: string | null; roles: string[]; unitId: string | null; superadmin?: boolean; direct?: boolean }): Promise<AddedPerson> {
  const email = p.email.toLowerCase();
  const existing = (await db.query('select id from app_user where email = $1', [email])).rows[0];
  let userId: string | undefined = existing?.id;
  let temp: string | undefined;

  if (!userId && localAuthEnabled(app.cfg)) {
    temp = randomBytes(9).toString('base64url');
    userId = (await db.query('insert into app_user (email, name, password_hash) values ($1,$2,$3) returning id', [email, p.name ?? null, await hashPassword(temp)])).rows[0].id;
  }
  if (userId && existing && !p.direct) {
    // An account that already exists (possibly in other properties) is invited, not attached: the person accepts, and nothing about
    // them (name, phone) is visible here until they do. (With local sign-in an unknown email gets a new account and a one-time
    // password instead, so whether an address already has an account can still be inferred from the response shape; deployments
    // that cannot accept this should use an external identity provider, where an unknown email is also just an invitation.)
    if ((await db.query('select 1 from membership where user_id = $1', [userId])).rowCount) throw new HttpError(409, 'already_member', 'That person already belongs to this tenant');
    userId = undefined;
  }
  if (userId) {
    const r = await db.query('insert into membership (tenant_id, user_id, roles, unit_id) values ($1,$2,$3,$4) on conflict do nothing', [tenantId, userId, p.roles, p.unitId]);
    if (!r.rowCount) throw new HttpError(409, 'already_member', 'That person already belongs to this tenant');
    return { userId, ...(temp ? { temporaryPassword: temp } : {}) };
  }
  await db.query(
    'insert into membership_invite (tenant_id, email, roles, unit_id, invited_by, superadmin) values ($1,$2,$3,$4,$5,$6) on conflict (tenant_id, email) do update set roles = excluded.roles, unit_id = excluded.unit_id, superadmin = excluded.superadmin',
    [tenantId, email, p.roles, p.unitId, invitedBy, !!p.superadmin]);
  return { invited: true };
}
