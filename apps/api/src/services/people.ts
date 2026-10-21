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
  p: { email: string; name?: string | null; roles: string[]; unitId: string | null; superadmin?: boolean }): Promise<AddedPerson> {
  const email = p.email.toLowerCase();
  const existing = (await db.query('select id from app_user where email = $1', [email])).rows[0];
  let userId: string | undefined = existing?.id;
  let temp: string | undefined;

  if (!userId && localAuthEnabled(app.cfg)) {
    temp = randomBytes(9).toString('base64url');
    userId = (await db.query('insert into app_user (email, name, password_hash) values ($1,$2,$3) returning id', [email, p.name ?? null, await hashPassword(temp)])).rows[0].id;
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
