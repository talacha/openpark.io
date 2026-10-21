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
  p: { email: string; name?: string | null; roles: string[]; unitId: string | null; superadmin?: boolean; direct?: boolean; unitVerified?: boolean; inviteOnly?: boolean }): Promise<AddedPerson> {
  const email = p.email.toLowerCase();
  const existing = (await db.query('select id from app_user where email = $1', [email])).rows[0];
  let userId: string | undefined = existing?.id;
  let temp: string | undefined;

  // inviteOnly (bulk users import): never create a local account or an OTP — an unknown email always becomes an
  // invitation, so no plaintext secret ever enters any export/diff/apply payload (NFR-SEC). An EXISTING account still
  // joins straight away (no secret involved) unless the caller is non-direct, in which case it is also invited.
  if (!userId && p.inviteOnly) {
    const verified = !!p.unitVerified;
    await db.query(
      'insert into membership_invite (tenant_id, email, roles, unit_id, invited_by, superadmin, unit_verified) values ($1,$2,$3,$4,$5,$6,$7) on conflict (tenant_id, email) do update set roles = excluded.roles, unit_id = excluded.unit_id, superadmin = excluded.superadmin, unit_verified = excluded.unit_verified',
      [tenantId, email, p.roles, p.unitId, invitedBy, !!p.superadmin, verified]);
    return { invited: true };
  }

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
  // Staff who place a grant vouch for the unit access; unvouched (bulk-import, request-access) grants default to false.
  const verified = !!p.unitVerified;
  if (userId) {
    const r = await db.query('insert into membership (tenant_id, user_id, roles, unit_id, unit_verified) values ($1,$2,$3,$4,$5) on conflict do nothing', [tenantId, userId, p.roles, p.unitId, verified]);
    if (!r.rowCount) throw new HttpError(409, 'already_member', 'That person already belongs to this tenant');
    return { userId, ...(temp ? { temporaryPassword: temp } : {}) };
  }
  await db.query(
    'insert into membership_invite (tenant_id, email, roles, unit_id, invited_by, superadmin, unit_verified) values ($1,$2,$3,$4,$5,$6,$7) on conflict (tenant_id, email) do update set roles = excluded.roles, unit_id = excluded.unit_id, superadmin = excluded.superadmin, unit_verified = excluded.unit_verified',
    [tenantId, email, p.roles, p.unitId, invitedBy, !!p.superadmin, verified]);
  return { invited: true };
}
