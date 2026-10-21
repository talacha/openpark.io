import { UnitsDoc, diffUnits, type LiveUnit, type UnitsDiff } from '@openpark/core';
import { audit, type Db } from '../db.js';
import { HttpError } from '../http.js';
import type { App } from '../server.js';
import { addPerson } from './people.js';

export async function loadLiveUnits(db: Db): Promise<LiveUnit[]> {
  const rows = (await db.query(
    `select u.code, u.name, s.code as site,
       coalesce((select json_agg(json_build_object('email', a.email) order by a.email) from membership m join app_user a on a.id = m.user_id where m.unit_id = u.id), '[]') as residents,
       exists (select 1 from pass p where p.unit_id = u.id) as has_passes,
       exists (select 1 from membership_invite i where i.unit_id = u.id) as has_invites
     from unit u left join site s on s.id = u.site_id order by u.code`)).rows;
  return rows.map((r) => ({ code: r.code, name: r.name, site: r.site, residents: r.residents, hasPasses: r.has_passes, hasInvites: r.has_invites }));
}

export async function exportUnits(db: Db, tenantSlug: string, now: Date) {
  const rows = (await db.query(
    `select u.code, u.name, s.code as site,
       coalesce((select json_agg(json_build_object('email', a.email, 'name', a.name) order by a.email)
                 from membership m join app_user a on a.id = m.user_id where m.unit_id = u.id), '[]') as residents
     from unit u left join site s on s.id = u.site_id order by u.code`)).rows;
  return {
    $schema: 'https://schemas.openpark.io/units/v1.json',
    schemaVersion: 1,
    tenant: tenantSlug,
    exportedAt: now.toISOString(),
    units: rows.map((r) => ({
      code: r.code, name: r.name, ...(r.site ? { site: r.site } : {}),
      residents: (r.residents as { email: string; name: string | null }[]).map((x) => ({ email: x.email, ...(x.name ? { name: x.name } : {}) })),
    })),
  };
}

/** Accepts the document itself, or `{ text }` holding raw JSON (so the editor can show a line and column). */
export function parseUnitsDoc(raw: unknown, locate: (t: string) => { line: number; column: number; message: string } | null): UnitsDoc {
  let value = raw;
  if (raw && typeof raw === 'object' && 'text' in raw && typeof (raw as { text: unknown }).text === 'string') {
    const text = (raw as { text: string }).text;
    try { value = JSON.parse(text); } catch (e) {
      const at = locate(text);
      throw new HttpError(400, 'invalid_json', at ? at.message : (e as Error).message, at ? { line: at.line, column: at.column } : undefined);
    }
  }
  const r = UnitsDoc.safeParse(value);
  if (!r.success) throw new HttpError(400, 'schema_invalid', 'Units file does not match schema v1', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

/** Diff plus the checks that need the database: every named site must exist, and a unit needs a site when there are several. */
export async function previewUnits(db: Db, doc: UnitsDoc, mode: 'merge' | 'replace'): Promise<UnitsDiff & { errors: { path: string; message: string }[] }> {
  const diff = diffUnits(await loadLiveUnits(db), doc.units, mode);
  const sites = (await db.query('select code from site where retired_at is null')).rows.map((r) => r.code as string);
  const errors: { path: string; message: string }[] = [];
  for (const s of diff.sites) if (!sites.includes(s)) errors.push({ path: 'units.site', message: `unknown site "${s}"` });
  return { ...diff, errors };
}

export interface ApplyResult { added: number; changed: number; removed: number; residents: { added: number; invited: number; created: { email: string; temporaryPassword: string }[]; skipped: { email: string; reason: string }[] } }

export async function applyUnits(app: App, db: Db, tenantId: string, actor: string | null, doc: UnitsDoc, mode: 'merge' | 'replace'): Promise<ApplyResult> {
  const diff = await previewUnits(db, doc, mode);
  if (diff.errors.length) throw new HttpError(400, 'invalid_sites', 'Some units name a site that does not exist', diff.errors);
  if (diff.conflicts.length) throw new HttpError(409, 'conflicts', 'Units with residents or guest passes would be removed', diff.conflicts);

  const siteId = async (code?: string) => (code ? (await db.query('select id from site where code = $1', [code])).rows[0]?.id ?? null : null);
  for (const u of doc.units) {
    await db.query(
      `insert into unit (tenant_id, site_id, code, name) values ($1,$2,$3,$4)
       on conflict (tenant_id, code) do update set name = excluded.name, site_id = case when $5 then excluded.site_id else unit.site_id end`,
      [tenantId, await siteId(u.site), u.code, u.name, u.site !== undefined]);
  }
  for (const u of diff.removed) await db.query('delete from unit where code = $1', [u.code]);

  const result: ApplyResult = { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, residents: { added: 0, invited: 0, created: [], skipped: [] } };
  for (const r of diff.residentsToAdd) {
    const unitId = (await db.query('select id from unit where code = $1', [r.unit])).rows[0].id as string;
    // Someone who already has a role in this tenant is left alone rather than silently changed.
    const known = (await db.query('select m.roles from membership m join app_user a on a.id = m.user_id where a.email = $1', [r.email])).rows[0];
    if (known) { result.residents.skipped.push({ email: r.email, reason: `already ${known.roles.join(' + ')} here` }); continue; }
    const added = await addPerson(app, db, tenantId, actor, { email: r.email, name: r.name, roles: ['resident'], unitId });
    if (added.temporaryPassword) result.residents.created.push({ email: r.email, temporaryPassword: added.temporaryPassword });
    else if (added.invited) result.residents.invited++;
    result.residents.added++;
  }
  await audit(db, tenantId, actor, 'units.import', 'unit', null, { mode, added: result.added, changed: result.changed, removed: result.removed, residents: { added: result.residents.added, invited: result.residents.invited } });
  return result;
}
