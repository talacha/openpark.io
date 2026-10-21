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
  /** An invitation OR a registered member whose roles/unit/verification the import changes. `kind` says which. */
  changed: { email: string; kind: 'invite' | 'member'; before: { roles: string[]; unit: string | null; unitVerified: boolean }; after: { roles: string[]; unit: string | null; unitVerified: boolean } }[];
  skipped: { email: string; reason: string }[];
  conflicts: { email: string; reason: string }[];
  errors: { path: string; message: string }[];
}

interface LiveMember { userId: string; email: string; name: string | null; roles: string[]; unit: string | null; unitId: string | null; unitVerified: boolean; superadmin: boolean }
interface LiveInvite { email: string; roles: string[]; unit: string | null; unitVerified: boolean }

async function loadLive(db: Db): Promise<{ members: LiveMember[]; invites: LiveInvite[]; units: Set<string> }> {
  const members = (await db.query(
    `select a.id as user_id, a.email, a.name, a.is_superadmin as superadmin, m.roles, m.unit_id, m.unit_verified, un.code as unit
     from membership m join app_user a on a.id = m.user_id left join unit un on un.id = m.unit_id`)).rows.map((r) => ({ userId: r.user_id, email: r.email.toLowerCase(), name: r.name, roles: r.roles, unit: r.unit, unitId: r.unit_id, unitVerified: r.unit_verified, superadmin: r.superadmin }));
  const invites = (await db.query(
    `select i.email, i.roles, un.code as unit, i.unit_verified from membership_invite i left join unit un on un.id = i.unit_id`)).rows.map((r) => ({ email: r.email.toLowerCase(), roles: r.roles, unit: r.unit, unitVerified: r.unit_verified }));
  const units = new Set((await db.query('select code from unit')).rows.map((r) => r.code as string));
  return { members, invites, units };
}

const sameRoles = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

/** The resolved verification flag the document asks for a row: a trusted whole-batch verify, else the per-row flag. */
function wantVerified(doc: UsersDoc, roles: string[], rowVerified?: boolean): boolean {
  return roles.includes('resident') ? (doc.verifyUnits || !!rowVerified) : false;
}

/**
 * Diff + the checks that need the database. A resident must name an existing unit. A registered MEMBER is now editable:
 * when the import changes their roles, unit or verification it is a `changed` row (kind: 'member'), applied
 * transactionally; an unchanged member is skipped. An `owner` membership is never demoted by an import (skipped).
 */
export async function previewUsers(db: Db, doc: UsersDoc): Promise<UsersDiff> {
  const live = await loadLive(db);
  const byMember = new Map(live.members.map((m) => [m.email, m]));
  const byInvite = new Map(live.invites.map((m) => [m.email, m]));
  const diff: UsersDiff = { added: [], changed: [], skipped: [], conflicts: [], errors: [] };
  doc.users.forEach((u, i) => {
    const email = u.email.toLowerCase();
    const roles = [...new Set(u.roles)];
    const unit = u.unit ?? null;
    const verified = wantVerified(doc, roles, u.unitVerified);
    if (roles.includes('resident') && (!unit || !live.units.has(unit))) {
      diff.errors.push({ path: `users.${i}.unit`, message: `resident "${u.email}" needs an existing unit` });
      return;
    }
    const member = byMember.get(email);
    if (member) {
      // An owner's membership is protected: the import document cannot even express the 'owner' role, so any member
      // who holds it is left entirely alone rather than silently demoted.
      if (member.roles.includes('owner')) { diff.skipped.push({ email: u.email, reason: 'owner is not editable by import' }); return; }
      const before = { roles: member.roles, unit: member.unit ?? null, unitVerified: member.unitVerified };
      const after = { roles, unit, unitVerified: verified };
      if (sameRoles(before.roles, after.roles) && before.unit === after.unit && before.unitVerified === after.unitVerified) diff.skipped.push({ email: u.email, reason: 'already a member' });
      else diff.changed.push({ email: u.email, kind: 'member', before, after });
      return;
    }
    const invite = byInvite.get(email);
    if (invite) diff.changed.push({ email: u.email, kind: 'invite', before: { roles: invite.roles, unit: invite.unit ?? null, unitVerified: invite.unitVerified }, after: { roles, unit, unitVerified: verified } });
    else diff.added.push({ email: u.email, roles, unit });
  });
  return diff;
}

export interface UsersApplyResult { added: number; changed: number; invited: number; skipped: { email: string; reason: string }[] }

/** The before-state of one invitation this job touched, captured at apply time so rollback restores exactly it. */
export interface InviteBefore { roles: string[]; unitId: string | null; superadmin: boolean; unitVerified: boolean; name: string | null }
/** The before AND applied-after state of one registered member this job edited; rollback reverts only if the live row
 *  still matches `after` (no admin changed it in between). */
export interface MemberChange { userId: string; before: { roles: string[]; unitId: string | null; unitVerified: boolean }; after: { roles: string[]; unitId: string | null; unitVerified: boolean } }
/**
 * What a users import changed, persisted so rollback is restorative and conflict-aware (never a blanket
 * delete-by-uploaded-email, never a last-writer-wins overwrite):
 *  - `created`: invitations the job created fresh (no prior invitation, no membership) — rollback withdraws each only
 *    if the live invitation still matches what the job created.
 *  - `restored`: emails whose pre-existing invitation the job overwrote — rollback puts the prior fields back, only if
 *    the live invitation still matches the job's applied state.
 *  - `members`: registered members the job edited — rollback reverts to `before` only if the live membership still
 *    matches `after`.
 * An email absent from all three is left untouched by rollback.
 */
export interface UsersRollback { created: { email: string; after: InviteBefore }[]; restored: Record<string, { before: InviteBefore; after: InviteBefore }>; members: MemberChange[] }

async function inviteState(db: Db, tenantId: string, email: string): Promise<InviteBefore | null> {
  const r = (await db.query('select roles, unit_id, superadmin, unit_verified, name from membership_invite where tenant_id = $1 and email = $2', [tenantId, email])).rows[0];
  return r ? { roles: r.roles, unitId: r.unit_id, superadmin: r.superadmin, unitVerified: r.unit_verified, name: r.name ?? null } : null;
}

const sameInvite = (a: InviteBefore | null, b: InviteBefore) =>
  !!a && sameRoles(a.roles, b.roles) && a.unitId === b.unitId && a.superadmin === b.superadmin && a.unitVerified === b.unitVerified;

/**
 * Apply the users document in one transaction. Every CREATED or edited-invitation row takes the INVITE path (no
 * plaintext OTP in any payload). Registered MEMBERS the import edits are updated transactionally in place, with their
 * before/after state captured for a conflict-aware rollback.
 */
export async function applyUsers(app: App, db: Db, tenantId: string, actor: string | null, doc: UsersDoc): Promise<UsersApplyResult & { rollback: UsersRollback }> {
  const diff = await previewUsers(db, doc);
  if (diff.errors.length) throw new HttpError(400, 'schema_invalid', 'Some rows name a unit that does not exist', diff.errors);
  const result: UsersApplyResult = { added: 0, changed: 0, invited: 0, skipped: diff.skipped };
  const rollback: UsersRollback = { created: [], restored: {}, members: [] };
  const want = new Map(doc.users.map((u) => [u.email.toLowerCase(), u]));
  const memberChanges = diff.changed.filter((c) => c.kind === 'member');
  const liveMembers = new Map((await db.query(
    `select a.email, a.id as user_id, m.roles, m.unit_id, m.unit_verified from membership m join app_user a on a.id = m.user_id`)).rows.map((r) => [r.email.toLowerCase(), r]));

  // 1. Registered members edited in place, capturing exact before/after for a conflict-aware rollback.
  for (const c of memberChanges) {
    const email = c.email.toLowerCase();
    const row = liveMembers.get(email);
    if (!row) { result.skipped.push({ email: c.email, reason: 'member no longer exists' }); continue; }
    const unitId = c.after.unit ? (await db.query('select id from unit where code = $1', [c.after.unit])).rows[0]?.id ?? null : null;
    const before = { roles: row.roles as string[], unitId: (row.unit_id as string | null) ?? null, unitVerified: row.unit_verified as boolean };
    const after = { roles: c.after.roles, unitId, unitVerified: c.after.unitVerified };
    await db.query('update membership set roles = $3, unit_id = $4, unit_verified = $5 where tenant_id = $1 and user_id = $2',
      [tenantId, row.user_id, after.roles, after.unitId, after.unitVerified]);
    // A name on the row updates the account name when the person has not set one themselves.
    const src = want.get(email);
    if (src?.name) await db.query('update app_user set name = coalesce(name, $2) where id = $1', [row.user_id, src.name]);
    rollback.members.push({ userId: row.user_id, before, after });
    result.changed++;
  }

  // 2. New rows + edited invitations via the invite path (no OTP, no secret in any payload).
  const toInvite = [...diff.added.map((a) => ({ email: a.email })), ...diff.changed.filter((c) => c.kind === 'invite').map((c) => ({ email: c.email }))];
  for (const row of toInvite) {
    const email = row.email.toLowerCase();
    const src = want.get(email)!;
    const roles = [...new Set(src.roles)];
    const unitId = src.unit ? (await db.query('select id from unit where code = $1', [src.unit])).rows[0]?.id ?? null : null;
    const verified = wantVerified(doc, roles, src.unitVerified);
    // Capture exact before-state BEFORE the upsert, so rollback restores an overwritten invite or withdraws a created one.
    const before = await inviteState(db, tenantId, email);
    try {
      // inviteOnly forces the invite path even under local auth: no OTP is generated, so no secret enters any payload.
      const added = await addPerson(app, db, tenantId, actor, { email: src.email, name: src.name ?? undefined, roles, unitId, direct: false, inviteOnly: true, unitVerified: verified });
      if (added.invited) {
        result.invited++;
        const after = (await inviteState(db, tenantId, email))!;
        if (before) rollback.restored[email] = { before, after }; // the job overwrote a pre-existing invitation
        else rollback.created.push({ email, after }); // the job created a brand-new invitation
      }
      result.added++;
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) result.skipped.push({ email: src.email, reason: 'already a member' });
      else throw e;
    }
  }
  await audit(db, tenantId, actor, 'users.import', 'membership_invite', null, { added: result.added, invited: result.invited, changed: result.changed, skipped: result.skipped.length });
  return { ...result, rollback };
}

/**
 * Undo a users import using the snapshot captured at apply time. Conflict-aware: each restore/withdraw/revert is
 * conditioned on the live row STILL matching what the job left (`after`). A row another admin changed after apply is
 * reported as a conflict and left as is, rather than clobbered. Only rows the job itself touched are considered.
 */
export async function rollbackUsers(db: Db, tenantId: string, actor: string | null, rb: UsersRollback): Promise<{ withdrawn: number; restored: number; members: number; conflicts: { email?: string; userId?: string; reason: string }[] }> {
  let withdrawn = 0, restored = 0, members = 0;
  const conflicts: { email?: string; userId?: string; reason: string }[] = [];
  for (const c of rb.created ?? []) {
    // Legacy jobs stored `created: string[]`; a bare string withdraws by email unconditionally (best effort).
    if (typeof c === 'string') {
      withdrawn += (await db.query('delete from membership_invite where tenant_id = $1 and email = $2', [tenantId, (c as string).toLowerCase()])).rowCount ?? 0;
      continue;
    }
    const live = await inviteState(db, tenantId, c.email);
    if (!live) continue; // already claimed/withdrawn — nothing to undo
    // Only withdraw a job-created invitation if it still matches what the job created (not edited since).
    if (!sameInvite(live, c.after)) { conflicts.push({ email: c.email, reason: 'invitation changed after the import; not withdrawing it' }); continue; }
    withdrawn += (await db.query('delete from membership_invite where tenant_id = $1 and email = $2', [tenantId, c.email.toLowerCase()])).rowCount ?? 0;
  }
  for (const [email, { before, after }] of Object.entries(rb.restored)) {
    const live = await inviteState(db, tenantId, email);
    if (!live) { conflicts.push({ email, reason: 'invitation gone (claimed or withdrawn); not restoring it' }); continue; }
    if (!sameInvite(live, after)) { conflicts.push({ email, reason: 'invitation changed after the import; not reverting it' }); continue; }
    const r = await db.query(
      'update membership_invite set roles = $3, unit_id = $4, superadmin = $5, unit_verified = $6, name = $7 where tenant_id = $1 and email = $2',
      [tenantId, email.toLowerCase(), before.roles, before.unitId, before.superadmin, before.unitVerified, before.name]);
    restored += r.rowCount ?? 0;
  }
  for (const m of rb.members) {
    const live = (await db.query('select roles, unit_id, unit_verified from membership where tenant_id = $1 and user_id = $2', [tenantId, m.userId])).rows[0];
    if (!live) { conflicts.push({ userId: m.userId, reason: 'membership gone; not reverting it' }); continue; }
    const same = sameRoles(live.roles, m.after.roles) && (live.unit_id ?? null) === m.after.unitId && live.unit_verified === m.after.unitVerified;
    if (!same) { conflicts.push({ userId: m.userId, reason: 'membership changed after the import; not reverting it' }); continue; }
    const r = await db.query('update membership set roles = $3, unit_id = $4, unit_verified = $5 where tenant_id = $1 and user_id = $2',
      [tenantId, m.userId, m.before.roles, m.before.unitId, m.before.unitVerified]);
    members += r.rowCount ?? 0;
  }
  await audit(db, tenantId, actor, 'users.rollback', 'membership_invite', null, { withdrawn, restored, members, conflicts: conflicts.length });
  return { withdrawn, restored, members, conflicts };
}

export async function exportUsers(db: Db, tenantSlug: string, now: Date) {
  const members = (await db.query(
    `select a.email, a.name, m.roles, un.code as unit, m.unit_verified from membership m join app_user a on a.id = m.user_id left join unit un on un.id = m.unit_id order by a.email`)).rows;
  const invites = (await db.query(
    `select i.email, i.name, i.roles, un.code as unit, i.unit_verified from membership_invite i left join unit un on un.id = i.unit_id order by i.email`)).rows;
  // No secrets: only email, name, roles, unit, unitVerified.
  const row = (r: { email: string; name?: string | null; roles: string[]; unit: string | null; unit_verified: boolean }) => ({
    email: r.email, ...(r.name ? { name: r.name } : {}), roles: r.roles, ...(r.unit ? { unit: r.unit } : {}), unitVerified: r.unit_verified,
  });
  return {
    $schema: 'https://schemas.openpark.io/users/v1.json',
    schemaVersion: 1,
    tenant: tenantSlug,
    exportedAt: now.toISOString(),
    users: [...members.map(row), ...invites.map(row)],
  };
}
