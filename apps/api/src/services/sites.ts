import { z } from 'zod';
import { audit, type Db } from '../db.js';
import { HttpError } from '../http.js';

/** A site row in a bulk sites document. Zones and slots stay in the inventory doc; this carries site-level fields only. */
const SiteRow = z.object({
  code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/),
  name: z.string().min(1).max(100),
  timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Unknown time zone'),
  address: z.string().max(300).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export const SitesDoc = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1).optional(),
  tenant: z.string().optional(),
  exportedAt: z.string().optional(),
  sites: z.array(SiteRow),
}).superRefine((d, ctx) => {
  const seen = new Set<string>();
  d.sites.forEach((s, i) => { if (seen.has(s.code)) ctx.addIssue({ code: 'custom', path: ['sites', i, 'code'], message: `duplicate site code "${s.code}"` }); seen.add(s.code); });
});
export type SitesDoc = z.infer<typeof SitesDoc>;

interface LiveSite { code: string; name: string; timezone: string; address: string | null; notes: string | null; open: number }

async function loadLiveSites(db: Db): Promise<LiveSite[]> {
  return (await db.query(
    `select code, name, timezone, address, settings->>'notes' as notes,
       (select count(*)::int from session x where x.site_id = s.id and x.status = 'open') as open
     from site s where retired_at is null order by code`)).rows.map((r) => ({ code: r.code, name: r.name, timezone: r.timezone, address: r.address, notes: r.notes, open: r.open }));
}

export function parseSitesDoc(raw: unknown, locate: (t: string) => { line: number; column: number; message: string } | null): SitesDoc {
  let value = raw;
  if (raw && typeof raw === 'object' && 'text' in raw && typeof (raw as { text: unknown }).text === 'string') {
    const text = (raw as { text: string }).text;
    try { value = JSON.parse(text); } catch (e) {
      const at = locate(text);
      throw new HttpError(400, 'invalid_json', at ? at.message : (e as Error).message, at ? { line: at.line, column: at.column } : undefined);
    }
  }
  const r = SitesDoc.safeParse(value);
  if (!r.success) throw new HttpError(400, 'schema_invalid', 'Sites file does not match schema v1', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

export interface SitesDiff {
  added: { code: string; name: string }[];
  changed: { before: { code: string; name: string }; after: { code: string; name: string } }[];
  removed: { code: string; name: string }[];
  conflicts: { site: { code: string }; reason: string }[];
}

/** Diff the document against live sites. `replace` removes live sites the document omits; a site with cars inside cannot be removed. */
export function diffSites(live: LiveSite[], doc: SitesDoc, mode: 'merge' | 'replace'): SitesDiff {
  const byCode = new Map(live.map((s) => [s.code, s]));
  const docCodes = new Set(doc.sites.map((s) => s.code));
  const diff: SitesDiff = { added: [], changed: [], removed: [], conflicts: [] };
  for (const s of doc.sites) {
    const cur = byCode.get(s.code);
    if (!cur) diff.added.push({ code: s.code, name: s.name });
    else if (cur.name !== s.name || cur.timezone !== s.timezone || (cur.address ?? null) !== (s.address ?? null) || (cur.notes ?? null) !== (s.notes ?? null)) {
      diff.changed.push({ before: { code: cur.code, name: cur.name }, after: { code: s.code, name: s.name } });
    }
  }
  if (mode === 'replace') {
    for (const s of live) if (!docCodes.has(s.code)) {
      if (s.open > 0) diff.conflicts.push({ site: { code: s.code }, reason: 'cars are still inside this site' });
      else diff.removed.push({ code: s.code, name: s.name });
    }
  }
  return diff;
}

export async function previewSites(db: Db, doc: SitesDoc, mode: 'merge' | 'replace'): Promise<SitesDiff> {
  return diffSites(await loadLiveSites(db), doc, mode);
}

export interface SitesApplyResult { added: number; changed: number; removed: number }

/** Apply the sites document in one transaction. Rebuilds the diff from live state first (it may have moved since preview). */
export async function applySites(db: Db, tenantId: string, actor: string | null, doc: SitesDoc, mode: 'merge' | 'replace'): Promise<SitesApplyResult> {
  const diff = await previewSites(db, doc, mode);
  if (diff.conflicts.length) throw new HttpError(409, 'conflicts', 'Sites with cars inside would be removed', diff.conflicts);
  // A new site shares the rate plan the community already uses so check-in works at once.
  const plan = (await db.query('select default_rate_plan_id from site where default_rate_plan_id is not null and retired_at is null order by code limit 1')).rows[0]?.default_rate_plan_id ?? null;
  for (const s of doc.sites) {
    await db.query(
      `insert into site (tenant_id, code, name, timezone, address, default_rate_plan_id, settings)
       values ($1,$2,$3,$4,$5,$6, jsonb_strip_nulls(jsonb_build_object('notes', $7::text)))
       on conflict (tenant_id, code) do update set name = excluded.name, timezone = excluded.timezone,
         address = excluded.address, retired_at = null,
         settings = site.settings || jsonb_strip_nulls(jsonb_build_object('notes', $7::text))`,
      [tenantId, s.code, s.name, s.timezone, s.address ?? null, plan, s.notes ?? null]);
  }
  for (const s of diff.removed) {
    const id = (await db.query('select id from site where code = $1 and retired_at is null', [s.code])).rows[0]?.id;
    if (id) {
      await db.query('update site set retired_at = now() where id = $1', [id]);
      await db.query('update slot set retired_at = coalesce(retired_at, now()) where site_id = $1', [id]);
      await db.query('update unit set site_id = null where site_id = $1', [id]);
    }
  }
  await audit(db, tenantId, actor, 'sites.import', 'site', null, { mode, added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length });
  return { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length };
}

/**
 * A restorative before-snapshot for a sites import. `exportSites` alone cannot undo a replace: it carries only active
 * site scalars, so it can revive a retired site row but not the slots that were retired with it, the units whose
 * `site_id` was nulled, or a note that was cleared. This captures exactly those dependent facts so rollback is exact:
 *  - `sites`: every active site's scalars INCLUDING address/notes as explicit null when unset (so a cleared note is restorable);
 *  - `slots`: the codes of the slots that are active per site today, so rollback un-retires precisely those;
 *  - `units`: the current unit→site association for every unit, so a nulled `site_id` can be re-pointed.
 */
export interface SitesSnapshot {
  sites: { code: string; name: string; timezone: string; address: string | null; notes: string | null }[];
  slots: { site: string; code: string }[];
  units: { code: string; site: string | null }[];
}

export async function snapshotSites(db: Db): Promise<SitesSnapshot> {
  const sites = (await db.query(
    "select code, name, timezone, address, settings->>'notes' as notes from site where retired_at is null order by code")).rows
    .map((r) => ({ code: r.code, name: r.name, timezone: r.timezone, address: r.address ?? null, notes: r.notes ?? null }));
  const slots = (await db.query(
    'select s.code as site, sl.code from slot sl join site s on s.id = sl.site_id where sl.retired_at is null and s.retired_at is null order by s.code, sl.code')).rows
    .map((r) => ({ site: r.site, code: r.code }));
  const units = (await db.query(
    'select u.code, s.code as site from unit u left join site s on s.id = u.site_id order by u.code')).rows
    .map((r) => ({ code: r.code, site: r.site ?? null }));
  return { sites, slots, units };
}

/**
 * Restore the exact pre-import state captured by {@link snapshotSites}, in one transaction:
 *  1. Un-retire (or upsert) every snapshotted site and set its scalars, clearing address/notes the import had set;
 *  2. Retire any site that exists now but was NOT in the snapshot (one the import added);
 *  3. Un-retire exactly the slots that were active before (leaving slots retired before the import retired);
 *  4. Re-point every unit's `site_id` to what it was, re-attaching associations the import nulled.
 * Slots/units the import may have touched are keyed by code, so the restore is idempotent.
 */
export async function restoreSites(db: Db, tenantId: string, actor: string | null, snap: SitesSnapshot): Promise<{ sites: number; slots: number; units: number }> {
  const plan = (await db.query('select default_rate_plan_id from site where default_rate_plan_id is not null order by code limit 1')).rows[0]?.default_rate_plan_id ?? null;
  const keep = new Set(snap.sites.map((s) => s.code));
  for (const s of snap.sites) {
    // Overwrite notes/address explicitly (no jsonb_strip_nulls) so a value the import SET is cleared back to null.
    await db.query(
      `insert into site (tenant_id, code, name, timezone, address, default_rate_plan_id, settings)
       values ($1,$2,$3,$4,$5,$6, jsonb_build_object('notes', $7::text))
       on conflict (tenant_id, code) do update set name = excluded.name, timezone = excluded.timezone,
         address = excluded.address, retired_at = null,
         settings = (site.settings - 'notes') || jsonb_build_object('notes', $7::text)`,
      [tenantId, s.code, s.name, s.timezone, s.address, plan, s.notes]);
  }
  // Retire sites the import added (present now, absent from the snapshot) and their slots.
  const live = (await db.query('select id, code from site where retired_at is null')).rows as { id: string; code: string }[];
  for (const s of live) if (!keep.has(s.code)) {
    await db.query('update site set retired_at = now() where id = $1', [s.id]);
    await db.query('update slot set retired_at = coalesce(retired_at, now()) where site_id = $1', [s.id]);
  }
  // Un-retire exactly the slots active before, by (site, code).
  let slots = 0;
  for (const sl of snap.slots) {
    const r = await db.query(
      `update slot set retired_at = null
       where code = $2 and site_id = (select id from site where tenant_id = $1 and code = $3)`,
      [tenantId, sl.code, sl.site]);
    slots += r.rowCount ?? 0;
  }
  // Re-point unit → site to the prior association (including back to a specific site the import nulled).
  let units = 0;
  for (const u of snap.units) {
    const r = await db.query(
      `update unit set site_id = $3 where code = $2 and tenant_id = $1 and site_id is distinct from $3`,
      [tenantId, u.code, u.site ? (await db.query('select id from site where tenant_id = $1 and code = $2', [tenantId, u.site])).rows[0]?.id ?? null : null]);
    units += r.rowCount ?? 0;
  }
  await audit(db, tenantId, actor, 'sites.rollback', 'site', null, { sites: snap.sites.length, slots, units });
  return { sites: snap.sites.length, slots, units };
}

export async function exportSites(db: Db, tenantSlug: string, now: Date) {
  const rows = (await db.query(
    "select code, name, timezone, address, settings->>'notes' as notes from site where retired_at is null order by code")).rows;
  return {
    $schema: 'https://schemas.openpark.io/sites/v1.json',
    schemaVersion: 1,
    tenant: tenantSlug,
    exportedAt: now.toISOString(),
    sites: rows.map((r) => ({ code: r.code, name: r.name, timezone: r.timezone, ...(r.address ? { address: r.address } : {}), ...(r.notes ? { notes: r.notes } : {}) })),
  };
}
