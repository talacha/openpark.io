import { z } from 'zod';
import { ROLES } from '../auth.js';
import { audit, type Db } from '../db.js';
import { HttpError } from '../http.js';
import type { App } from '../server.js';
import { addPerson } from './people.js';

/** A user row in a bulk users document. Carries NO secrets — only identity, roles, unit and verification. */
const UserRow = z.object({
  email: z.string().email().max(254),
  name: z.string().trim().max(100).nullable().optional(),
  roles: z.array(z.enum(ROLES)).min(1),
  unit: z.string().max(30).nullable().optional(),
  unitVerified: z.boolean().optional(),
});
export const UsersDoc = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1).optional(),
  tenant: z.string().optional(),
  exportedAt: z.string().optional(),
  /** When true, every created resident row is marked unit-verified (a trusted import vouches for the whole batch). */
  verifyUnits: z.boolean().optional(),
  users: z.array(UserRow),
}).superRefine((d, ctx) => {
  const seen = new Set<string>();
  d.users.forEach((u, i) => { const e = u.email.toLowerCase(); if (seen.has(e)) ctx.addIssue({ code: 'custom', path: ['users', i, 'email'], message: `duplicate email "${u.email}"` }); seen.add(e); });
});
export type UsersDoc = z.infer<typeof UsersDoc>;

export function parseUsersDoc(raw: unknown, locate: (t: string) => { line: number; column: number; message: string } | null): UsersDoc {
  let value = raw;
  if (raw && typeof raw === 'object' && 'text' in raw && typeof (raw as { text: unknown }).text === 'string') {
    const text = (raw as { text: string }).text;
    try { value = JSON.parse(text); } catch (e) {
      const at = locate(text);
      throw new HttpError(400, 'invalid_json', at ? at.message : (e as Error).message, at ? { line: at.line, column: at.column } : undefined);
    }
  }
  const r = UsersDoc.safeParse(value);
  if (!r.success) throw new HttpError(400, 'schema_invalid', 'Users file does not match schema v1', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

export interface UsersDiff {
  added: { email: string; roles: string[]; unit: string | null }[];
  changed: { email: string; before: { roles: string[]; unit: string | null }; after: { roles: string[]; unit: string | null } }[];
  skipped: { email: string; reason: string }[];
  conflicts: { email: string; reason: string }[];
  errors: { path: string; message: string }[];
}

interface LiveUser { email: string; roles: string[]; unit: string | null }

async function loadLive(db: Db): Promise<{ members: LiveUser[]; invites: LiveUser[]; units: Set<string> }> {
  const members = (await db.query(
    `select a.email, m.roles, un.code as unit from membership m join app_user a on a.id = m.user_id left join unit un on un.id = m.unit_id`)).rows.map((r) => ({ email: r.email.toLowerCase(), roles: r.roles, unit: r.unit }));
  const invites = (await db.query(
    `select i.email, i.roles, un.code as unit from membership_invite i left join unit un on un.id = i.unit_id`)).rows.map((r) => ({ email: r.email.toLowerCase(), roles: r.roles, unit: r.unit }));
  const units = new Set((await db.query('select code from unit')).rows.map((r) => r.code as string));
  return { members, invites, units };
}

const sameRoles = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

/** Diff + the checks that need the database: a resident must name an existing unit; existing members are left alone. */
export async function previewUsers(db: Db, doc: UsersDoc): Promise<UsersDiff> {
  const live = await loadLive(db);
  const byMember = new Map(live.members.map((m) => [m.email, m]));
  const byInvite = new Map(live.invites.map((m) => [m.email, m]));
  const diff: UsersDiff = { added: [], changed: [], skipped: [], conflicts: [], errors: [] };
  doc.users.forEach((u, i) => {
    const email = u.email.toLowerCase();
    const roles = [...new Set(u.roles)];
    const unit = u.unit ?? null;
    if (roles.includes('resident') && (!unit || !live.units.has(unit))) {
      diff.errors.push({ path: `users.${i}.unit`, message: `resident "${u.email}" needs an existing unit` });
      return;
    }
    const member = byMember.get(email);
    if (member) {
      // An existing member is never silently changed by an import.
      if (!sameRoles(member.roles, roles) || (member.unit ?? null) !== unit) diff.skipped.push({ email: u.email, reason: `already ${member.roles.join(' + ')} here` });
      else diff.skipped.push({ email: u.email, reason: 'already a member' });
      return;
    }
    if (byInvite.get(email)) diff.changed.push({ email: u.email, before: byInvite.get(email)!, after: { roles, unit } });
    else diff.added.push({ email: u.email, roles, unit });
  });
  return diff;
}

export interface UsersApplyResult { added: number; changed: number; invited: number; skipped: { email: string; reason: string }[] }

/** The before-state of one invitation this job touched, captured at apply time so rollback restores exactly it. */
export interface InviteBefore { roles: string[]; unitId: string | null; superadmin: boolean; unitVerified: boolean }
/**
 * What a users import changed, persisted so rollback is restorative (never a blanket delete-by-uploaded-email):
 *  - `created`: emails that had NO prior invitation and NO membership — rollback withdraws only these.
 *  - `restored`: emails whose pre-existing invitation the job overwrote — rollback puts the prior fields back.
 * An email absent from both is left untouched by rollback (e.g. a row skipped because it was already a member).
 */
export interface UsersRollback { created: string[]; restored: Record<string, InviteBefore> }

async function inviteBefore(db: Db, tenantId: string, email: string): Promise<InviteBefore | null> {
  const r = (await db.query('select roles, unit_id, superadmin, unit_verified from membership_invite where tenant_id = $1 and email = $2', [tenantId, email])).rows[0];
  return r ? { roles: r.roles, unitId: r.unit_id, superadmin: r.superadmin, unitVerified: r.unit_verified } : null;
}

/** Apply the users document in one transaction. Every created row takes the INVITE path (no plaintext OTP in any payload). */
export async function applyUsers(app: App, db: Db, tenantId: string, actor: string | null, doc: UsersDoc): Promise<UsersApplyResult & { rollback: UsersRollback }> {
  const diff = await previewUsers(db, doc);
  if (diff.errors.length) throw new HttpError(400, 'schema_invalid', 'Some rows name a unit that does not exist', diff.errors);
  const result: UsersApplyResult = { added: 0, changed: 0, invited: 0, skipped: diff.skipped };
  const rollback: UsersRollback = { created: [], restored: {} };
  const toApply = [...diff.added, ...diff.changed.map((c) => ({ email: c.email, roles: c.after.roles, unit: c.after.unit }))];
  const want = new Map(doc.users.map((u) => [u.email.toLowerCase(), u]));
  for (const row of toApply) {
    const email = row.email.toLowerCase();
    const src = want.get(email)!;
    const unitId = row.unit ? (await db.query('select id from unit where code = $1', [row.unit])).rows[0]?.id ?? null : null;
    // verifyUnits marks a whole trusted import verified; otherwise a per-row unitVerified, else unvouched (false).
    const verified = row.roles.includes('resident') ? (doc.verifyUnits || !!src.unitVerified) : false;
    // Capture exact before-state BEFORE the upsert, so rollback restores an overwritten invite or withdraws a created one.
    const before = await inviteBefore(db, tenantId, email);
    try {
      // inviteOnly forces the invite path even under local auth: no OTP is generated, so no secret enters any payload.
      const added = await addPerson(app, db, tenantId, actor, { email: row.email, name: src.name ?? undefined, roles: row.roles, unitId, direct: false, inviteOnly: true, unitVerified: verified });
      if (added.invited) {
        result.invited++;
        if (before) rollback.restored[email] = before; // the job overwrote a pre-existing invitation
        else rollback.created.push(email); // the job created a brand-new invitation
      }
      result.added++;
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) result.skipped.push({ email: row.email, reason: 'already a member' });
      else throw e;
    }
  }
  result.changed = diff.changed.length;
  await audit(db, tenantId, actor, 'users.import', 'membership_invite', null, { added: result.added, invited: result.invited, changed: result.changed, skipped: result.skipped.length });
  return { ...result, rollback };
}

/**
 * Undo a users import using the snapshot captured at apply time. Only touches invitations the job itself created or
 * overwrote, and only if they still exist as invitations (a claimed invite — the person already joined — is left
 * alone). Restores overwritten invitations to their exact prior roles/unit/superadmin/verification.
 */
export async function rollbackUsers(db: Db, tenantId: string, actor: string | null, rb: UsersRollback): Promise<{ withdrawn: number; restored: number }> {
  let withdrawn = 0, restored = 0;
  for (const email of rb.created) {
    const r = await db.query('delete from membership_invite where tenant_id = $1 and email = $2', [tenantId, email.toLowerCase()]);
    withdrawn += r.rowCount ?? 0;
  }
  for (const [email, b] of Object.entries(rb.restored)) {
    const r = await db.query(
      'update membership_invite set roles = $3, unit_id = $4, superadmin = $5, unit_verified = $6 where tenant_id = $1 and email = $2',
      [tenantId, email.toLowerCase(), b.roles, b.unitId, b.superadmin, b.unitVerified]);
    restored += r.rowCount ?? 0;
  }
  await audit(db, tenantId, actor, 'users.rollback', 'membership_invite', null, { withdrawn, restored });
  return { withdrawn, restored };
}

export async function exportUsers(db: Db, tenantSlug: string, now: Date) {
  const members = (await db.query(
    `select a.email, a.name, m.roles, un.code as unit, m.unit_verified from membership m join app_user a on a.id = m.user_id left join unit un on un.id = m.unit_id order by a.email`)).rows;
  const invites = (await db.query(
    `select i.email, i.roles, un.code as unit, i.unit_verified from membership_invite i left join unit un on un.id = i.unit_id order by i.email`)).rows;
  // No secrets: only email, name, roles, unit, unitVerified.
  const row = (r: { email: string; name?: string | null; roles: string[]; unit: string | null; unit_verified: boolean }) => ({
    email: r.email, ...(r.name ? { name: r.name } : {}), roles: r.roles, ...(r.unit ? { unit: r.unit } : {}), unitVerified: r.unit_verified,
  });
  return {
    $schema: 'https://schemas.openpark.io/users/v1.json',
    schemaVersion: 1,
    tenant: tenantSlug,
    exportedAt: now.toISOString(),
    users: [...members.map(row), ...invites.map((i) => row({ ...i, name: null }))],
  };
}
