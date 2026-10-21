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

/** The scalar state of one site the job touched, captured both as it was BEFORE and AFTER apply, so rollback can
 * (a) detect an intervening edit by another admin and (b) put back exactly what this job changed. `missing` marks a
 * site that did not exist before (the job created it) — rollback retires it rather than reviving a phantom. */
export interface SiteState { code: string; name: string; timezone: string; address: string | null; notes: string | null; missing?: boolean }

/**
 * What a sites import changed, persisted at apply time so rollback is scoped to job-owned rows and conflict-aware:
 *  - `sites`: for every site code the job created or edited, the before + after scalar state.
 *  - `removedUnits`: unit→site associations the job nulled by retiring a site, so rollback can re-point exactly those.
 * A site/unit the job never touched is absent here and left untouched by rollback.
 */
export interface SitesSnapshot {
  sites: { code: string; before: SiteState; after: SiteState }[];
  removedUnits: { code: string; site: string }[];
}

async function siteStateByCode(db: Db, code: string): Promise<SiteState | null> {
  const r = (await db.query(
    "select code, name, timezone, address, settings->>'notes' as notes from site where code = $1 and retired_at is null", [code])).rows[0];
  return r ? { code: r.code, name: r.name, timezone: r.timezone, address: r.address ?? null, notes: r.notes ?? null } : null;
}

/** Apply the sites document in one transaction and return a scoped before/after snapshot for a safe rollback.
 *  Rebuilds the diff from live state first (it may have moved since preview). */
export async function applySites(db: Db, tenantId: string, actor: string | null, doc: SitesDoc, mode: 'merge' | 'replace'): Promise<SitesApplyResult & { snapshot: SitesSnapshot }> {
  const diff = await previewSites(db, doc, mode);
  if (diff.conflicts.length) throw new HttpError(409, 'conflicts', 'Sites with cars inside would be removed', diff.conflicts);
  const snapshot: SitesSnapshot = { sites: [], removedUnits: [] };
  // A new site shares the rate plan the community already uses so check-in works at once.
  const plan = (await db.query('select default_rate_plan_id from site where default_rate_plan_id is not null and retired_at is null order by code limit 1')).rows[0]?.default_rate_plan_id ?? null;
  for (const s of doc.sites) {
    // Capture the before-state of exactly this row BEFORE the upsert (null → the job is creating it).
    const before = (await siteStateByCode(db, s.code)) ?? { code: s.code, name: s.name, timezone: s.timezone, address: null, notes: null, missing: true };
    await db.query(
      // Distinguish an omitted notes/address (leave as-is) from an explicit null (clear it): `$8`/`$9` are the
      // "was it provided?" flags, so an omitted key never overwrites an existing value, and an explicit null does.
      `insert into site (tenant_id, code, name, timezone, address, default_rate_plan_id, settings)
       values ($1,$2,$3,$4,$5,$6, jsonb_build_object('notes', $7::text))
       on conflict (tenant_id, code) do update set name = excluded.name, timezone = excluded.timezone,
         address = case when $9 then excluded.address else site.address end, retired_at = null,
         settings = case when $8 then (site.settings - 'notes') || jsonb_build_object('notes', $7::text) else site.settings end`,
      [tenantId, s.code, s.name, s.timezone, s.address ?? null, plan, s.notes ?? null,
        s.notes !== undefined, s.address !== undefined]);
    const after = (await siteStateByCode(db, s.code))!;
    snapshot.sites.push({ code: s.code, before, after });
  }
  for (const s of diff.removed) {
    const id = (await db.query('select id from site where code = $1 and retired_at is null', [s.code])).rows[0]?.id;
    if (id) {
      // Capture the unit associations this removal nulls, so rollback can re-point exactly those units.
      const units = (await db.query('select code from unit where site_id = $1', [id])).rows as { code: string }[];
      for (const u of units) snapshot.removedUnits.push({ code: u.code, site: s.code });
      const before = (await siteStateByCode(db, s.code))!;
      await db.query('update site set retired_at = now() where id = $1', [id]);
      await db.query('update slot set retired_at = coalesce(retired_at, now()) where site_id = $1', [id]);
      await db.query('update unit set site_id = null where site_id = $1', [id]);
      // A removed site's after-state is "retired": rollback revives it by upserting the before scalars.
      snapshot.sites.push({ code: s.code, before, after: { ...before, missing: true } });
    }
  }
  await audit(db, tenantId, actor, 'sites.import', 'site', null, { mode, added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length });
  return { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, snapshot };
}

export interface SitesRollbackResult {
  sites: number; units: number;
  conflicts: { code: string; reason: string }[];
}

const scalarsMatch = (a: SiteState, b: SiteState) =>
  a.name === b.name && a.timezone === b.timezone && (a.address ?? null) === (b.address ?? null) && (a.notes ?? null) === (b.notes ?? null);

/**
 * Restore ONLY the rows this job touched, and only when they still hold the state the job left them in — so a later
 * admin's unrelated edit (or a new site, or a check-in at a site the import created) is never clobbered. For every
 * site in the snapshot:
 *  - the job CREATED it (`before.missing`): retire it again — but refuse if a car is now inside (block retirement with
 *    an open session), and refuse if its scalars no longer match the applied state (someone edited it after apply);
 *  - the job RETIRED it (`after.missing`): revive it to its before-scalars, but only if it is still retired (a later
 *    admin may have revived/recreated it);
 *  - the job EDITED it: restore before-scalars, but only if the live row still equals the applied after-state.
 * Unit associations the job nulled by retiring a site are re-pointed only when the unit still has no site.
 * Each skipped row is surfaced as a conflict rather than silently overwritten.
 */
export async function restoreSites(db: Db, tenantId: string, actor: string | null, snap: SitesSnapshot): Promise<SitesRollbackResult> {
  const plan = (await db.query('select default_rate_plan_id from site where default_rate_plan_id is not null order by code limit 1')).rows[0]?.default_rate_plan_id ?? null;
  const result: SitesRollbackResult = { sites: 0, units: 0, conflicts: [] };
  const revived = new Set<string>();
  for (const { code, before, after } of snap.sites) {
    const live = await siteStateByCode(db, code); // null => currently retired/absent
    if (before.missing) {
      // The job created this site. Retire it again, unless it is now in use or was edited after apply.
      if (!live) continue; // already retired (idempotent rollback) — nothing to do
      const open = (await db.query("select count(*)::int as n from session x join site s on s.id = x.site_id where s.code = $1 and x.status = 'open'", [code])).rows[0].n;
      if (open > 0) { result.conflicts.push({ code, reason: 'a car is inside the site this import created' }); continue; }
      if (!scalarsMatch(live, after)) { result.conflicts.push({ code, reason: 'edited after the import; not retiring it' }); continue; }
      const id = (await db.query('select id from site where code = $1 and retired_at is null', [code])).rows[0]?.id;
      if (id) {
        await db.query('update site set retired_at = now() where id = $1', [id]);
        await db.query('update slot set retired_at = coalesce(retired_at, now()) where site_id = $1', [id]);
        await db.query('update unit set site_id = null where site_id = $1', [id]);
        result.sites++;
      }
      continue;
    }
    if (after.missing) {
      // The job retired this site. Revive it only if still retired (a later admin may have recreated it).
      if (live) { result.conflicts.push({ code, reason: 'recreated after the import; leaving it as is' }); continue; }
    } else if (!live || !scalarsMatch(live, after)) {
      // The job edited this site. Only restore if the live row still matches what the job left.
      result.conflicts.push({ code, reason: 'changed after the import; not reverting it' }); continue;
    }
    // Safe to restore the before-scalars (reviving a retired row or reverting an edit). Overwrite notes/address
    // explicitly so a value the import SET is cleared back to its prior value.
    await db.query(
      `insert into site (tenant_id, code, name, timezone, address, default_rate_plan_id, settings)
       values ($1,$2,$3,$4,$5,$6, jsonb_build_object('notes', $7::text))
       on conflict (tenant_id, code) do update set name = excluded.name, timezone = excluded.timezone,
         address = excluded.address, retired_at = null,
         settings = (site.settings - 'notes') || jsonb_build_object('notes', $7::text)`,
      [tenantId, before.code, before.name, before.timezone, before.address, plan, before.notes]);
    result.sites++;
    revived.add(code);
  }
  // Re-point units the job detached, but only onto a site we actually revived and only if the unit is still unattached.
  for (const u of snap.removedUnits) {
    if (!revived.has(u.site)) continue;
    const siteId = (await db.query('select id from site where tenant_id = $1 and code = $2', [tenantId, u.site])).rows[0]?.id ?? null;
    if (!siteId) continue;
    const r = await db.query('update unit set site_id = $3 where code = $2 and tenant_id = $1 and site_id is null', [tenantId, u.code, siteId]);
    result.units += r.rowCount ?? 0;
  }
  await audit(db, tenantId, actor, 'sites.rollback', 'site', null, { sites: result.sites, units: result.units, conflicts: result.conflicts.length });
  return result;
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
