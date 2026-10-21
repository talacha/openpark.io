import { z } from 'zod';
import { audit, type Db } from '../db.js';
import { HttpError } from '../http.js';

/**
 * The Community (the tenant itself) bulk pipeline. A tenant-scoped export is a single Community row carrying its
 * surfaced identity — name, optional address, optional notes. It reuses the same validate → preview → apply →
 * rollback contract as the other bulk documents, so the Bulk screen drives it identically; there is simply one row.
 * It never renames the tenant table, changes the slug, or touches tenancy/RLS: only the editable scalar fields.
 */
const CommunityRow = z.object({
  slug: z.string().optional(), // informational only; the acting tenant is fixed by the request context
  name: z.string().min(1).max(100),
  address: z.string().max(300).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export const CommunityDoc = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1).optional(),
  tenant: z.string().optional(),
  exportedAt: z.string().optional(),
  // One community per tenant context; a single-element array keeps the document shape uniform with the other bulk docs.
  communities: z.array(CommunityRow).min(1).max(1),
}).superRefine((d, ctx) => {
  if (d.communities.length !== 1) ctx.addIssue({ code: 'custom', path: ['communities'], message: 'exactly one community row is expected' });
});
export type CommunityDoc = z.infer<typeof CommunityDoc>;

export function parseCommunityDoc(raw: unknown, locate: (t: string) => { line: number; column: number; message: string } | null): CommunityDoc {
  let value = raw;
  if (raw && typeof raw === 'object' && 'text' in raw && typeof (raw as { text: unknown }).text === 'string') {
    const text = (raw as { text: string }).text;
    try { value = JSON.parse(text); } catch (e) {
      const at = locate(text);
      throw new HttpError(400, 'invalid_json', at ? at.message : (e as Error).message, at ? { line: at.line, column: at.column } : undefined);
    }
  }
  const r = CommunityDoc.safeParse(value);
  if (!r.success) throw new HttpError(400, 'schema_invalid', 'Community file does not match schema v1', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

interface CommunityState { name: string; address: string | null; notes: string | null }

async function loadCommunity(db: Db): Promise<CommunityState> {
  const r = (await db.query("select name, settings->>'address' as address, settings->>'notes' as notes from tenant")).rows[0];
  return { name: r.name, address: r.address ?? null, notes: r.notes ?? null };
}

export interface CommunityDiff {
  changed: { before: CommunityState; after: CommunityState }[];
  conflicts: never[];
  errors: never[];
}

export async function previewCommunity(db: Db, doc: CommunityDoc): Promise<CommunityDiff> {
  const cur = await loadCommunity(db);
  const row = doc.communities[0]!;
  const after: CommunityState = {
    name: row.name,
    address: row.address === undefined ? cur.address : row.address,
    notes: row.notes === undefined ? cur.notes : row.notes,
  };
  const changed = cur.name !== after.name || cur.address !== after.address || cur.notes !== after.notes;
  return { changed: changed ? [{ before: cur, after }] : [], conflicts: [], errors: [] };
}

/** The community's before-state, captured at apply time so rollback restores exactly it (conflict-aware). */
export interface CommunitySnapshot { before: CommunityState; after: CommunityState }

/**
 * Apply the community document in one transaction: update the tenant name, and set address/notes while distinguishing
 * an omitted key (leave as-is) from an explicit null (clear it). Returns the before/after snapshot for rollback.
 * Never touches slug, RLS, or any other tenancy field.
 */
export async function applyCommunity(db: Db, tenantId: string, actor: string | null, doc: CommunityDoc): Promise<{ changed: number; snapshot: CommunitySnapshot }> {
  const before = await loadCommunity(db);
  const row = doc.communities[0]!;
  await db.query(
    // $3/$4 are the "was it provided?" flags, so an omitted key never overwrites and an explicit null clears.
    `update tenant set name = $1,
       settings = (case when $3 then (settings - 'address') || jsonb_build_object('address', $2::text) else settings end)`,
    [row.name, row.address ?? null, row.address !== undefined]);
  await db.query(
    `update tenant set settings = (case when $2 then (settings - 'notes') || jsonb_build_object('notes', $1::text) else settings end)`,
    [row.notes ?? null, row.notes !== undefined]);
  const after = await loadCommunity(db);
  await audit(db, tenantId, actor, 'community.import', 'tenant', before, after);
  return { changed: before.name !== after.name || before.address !== after.address || before.notes !== after.notes ? 1 : 0, snapshot: { before, after } };
}

const sameState = (a: CommunityState, b: CommunityState) => a.name === b.name && a.address === b.address && a.notes === b.notes;

/**
 * Restore the community's pre-import state, but only if the live row still matches what the job left (`after`). If
 * another admin edited the community after apply, that is reported as a conflict and left as is, never clobbered.
 */
export async function restoreCommunity(db: Db, tenantId: string, actor: string | null, snap: CommunitySnapshot): Promise<{ restored: number; conflicts: { reason: string }[] }> {
  const live = await loadCommunity(db);
  if (!sameState(live, snap.after)) {
    await audit(db, tenantId, actor, 'community.rollback', 'tenant', live, null);
    return { restored: 0, conflicts: [{ reason: 'the community was changed after the import; not reverting it' }] };
  }
  await db.query(
    `update tenant set name = $1,
       settings = (settings - 'address' - 'notes') || jsonb_build_object('address', $2::text, 'notes', $3::text)`,
    [snap.before.name, snap.before.address, snap.before.notes]);
  await audit(db, tenantId, actor, 'community.rollback', 'tenant', snap.after, snap.before);
  return { restored: 1, conflicts: [] };
}

export async function exportCommunity(db: Db, tenantSlug: string, now: Date) {
  const cur = await loadCommunity(db);
  return {
    $schema: 'https://schemas.openpark.io/community/v1.json',
    schemaVersion: 1,
    tenant: tenantSlug,
    exportedAt: now.toISOString(),
    communities: [{
      slug: tenantSlug, name: cur.name,
      ...(cur.address ? { address: cur.address } : {}),
      ...(cur.notes ? { notes: cur.notes } : {}),
    }],
  };
}
