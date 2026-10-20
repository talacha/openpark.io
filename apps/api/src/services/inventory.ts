import { diffInventory, flattenInventory, type FlatSlot, type InventoryDiff, type InventoryDoc, type LiveSlot } from '@openpark/core';
import type { Db } from '../db.js';

const labelText = (l: string | Record<string, string>): { name: string; labels: Record<string, string> } =>
  typeof l === 'string' ? { name: l, labels: {} } : { name: l.en ?? Object.values(l)[0] ?? '', labels: l };

export async function loadLiveSlots(db: Db): Promise<LiveSlot[]> {
  const { rows } = await db.query(
    `select s.code as site, z.code as zone, sl.code, sl.type, sl.status, sl.attributes, sl.assignment, sl.note
     from slot sl join site s on s.id = sl.site_id join zone z on z.id = sl.zone_id
     where sl.retired_at is null order by s.code, sl.code`);
  return rows.map((r) => ({ ...r, note: r.note ?? undefined }));
}

export function previewImport(live: LiveSlot[], doc: InventoryDoc, mode: 'merge' | 'replace'): InventoryDiff {
  return diffInventory(live, flattenInventory(doc), mode);
}

/** Create or update sites and zones named in the document. */
async function applyStructure(db: Db, tenantId: string, doc: InventoryDoc) {
  if (doc.slotTypes.length) {
    await db.query('update tenant set slot_types = $1::jsonb', [JSON.stringify(doc.slotTypes)]);
  }
  for (const site of doc.sites) {
    await db.query(
      `insert into site (tenant_id, code, name, timezone, address) values ($1,$2,$3,$4,$5)
       on conflict (tenant_id, code) do update set name = excluded.name, timezone = excluded.timezone,
         address = coalesce(excluded.address, site.address), retired_at = null`,
      [tenantId, site.code, site.name, site.timezone, site.address ?? null]);
    const siteId = (await db.query('select id from site where code = $1', [site.code])).rows[0].id;
    let sort = 0;
    for (const z of site.zones) {
      const { name, labels } = labelText(z.name);
      await db.query(
        `insert into zone (tenant_id, site_id, code, name, labels, level, sort) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (site_id, code) do update set name = excluded.name, labels = excluded.labels, level = excluded.level, sort = excluded.sort`,
        [tenantId, siteId, z.code, name, JSON.stringify(labels), z.level ?? null, sort++]);
    }
  }
}

/** Apply slot-level changes. Sites and zones must already exist. */
export async function applySlots(db: Db, tenantId: string, diff: InventoryDiff) {
  const ids = new Map<string, string>();
  const lookup = async (site: string, zone: string) => {
    const key = `${site}/${zone}`;
    if (!ids.has(key)) {
      const r = await db.query('select s.id as site_id, z.id as zone_id from site s join zone z on z.site_id = s.id where s.code = $1 and z.code = $2', [site, zone]);
      if (!r.rows[0]) throw new Error(`unknown zone ${key}`);
      ids.set(key, `${r.rows[0].site_id}|${r.rows[0].zone_id}`);
    }
    return ids.get(key)!.split('|') as [string, string];
  };
  const upsert = async (s: FlatSlot) => {
    const [siteId, zoneId] = await lookup(s.site, s.zone);
    await db.query(
      `insert into slot (tenant_id, site_id, zone_id, code, type, attributes, status, assignment, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (site_id, code) do update set zone_id = excluded.zone_id, type = excluded.type,
         attributes = excluded.attributes, assignment = excluded.assignment, note = excluded.note, retired_at = null,
         status = case when slot.status = 'occupied' and excluded.status = 'available' then 'occupied' else excluded.status end`,
      [tenantId, siteId, zoneId, s.code, s.type, JSON.stringify(s.attributes), s.status, s.assignment ? JSON.stringify(s.assignment) : null, s.note ?? null]);
    const permit = s.assignment?.permit;
    if (permit) {
      const slotId = (await db.query('select id from slot where site_id = $1 and code = $2', [siteId, s.code])).rows[0].id;
      await db.query(
        `insert into permit (tenant_id, ref, slot_id, kind) values ($1,$2,$3,'assigned')
         on conflict (tenant_id, ref) do update set slot_id = excluded.slot_id`, [tenantId, permit, slotId]);
    }
  };
  for (const s of diff.added) await upsert(s);
  for (const c of diff.changed) await upsert(c.after);
  for (const s of diff.retired) {
    await db.query('update slot set retired_at = now() where code = $2 and site_id = (select id from site where code = $1)', [s.site, s.code]);
  }
}

export async function applyInventory(db: Db, tenantId: string, doc: InventoryDoc, diff: InventoryDiff) {
  await applyStructure(db, tenantId, doc);
  await applySlots(db, tenantId, diff);
}

/** Build the export document from live state. Runtime `occupied` is exported as `available`. */
export async function exportInventory(db: Db, tenantSlug: string, now: Date, filter: { site?: string; zone?: string }) {
  const tenant = (await db.query('select slot_types from tenant')).rows[0];
  const sites = (await db.query('select id, code, name, timezone, address from site where retired_at is null and ($1::text is null or code = $1) order by code', [filter.site ?? null])).rows;
  const out = [];
  for (const s of sites) {
    const zones = (await db.query('select id, code, name, labels, level from zone where site_id = $1 and ($2::text is null or code = $2) order by sort, code', [s.id, filter.zone ?? null])).rows;
    out.push({
      code: s.code, name: s.name, timezone: s.timezone, ...(s.address ? { address: s.address } : {}),
      zones: await Promise.all(zones.map(async (z) => {
        const slots = (await db.query('select code, type, status, attributes, assignment, note from slot where zone_id = $1 and retired_at is null order by code', [z.id])).rows;
        return {
          code: z.code,
          name: Object.keys(z.labels).length ? z.labels : z.name,
          ...(z.level !== null ? { level: z.level } : {}),
          slots: slots.map((r) => ({
            code: r.code, type: r.type,
            ...(r.status !== 'available' && r.status !== 'occupied' ? { status: r.status } : {}),
            ...(Object.keys(r.attributes).length ? { attributes: r.attributes } : {}),
            ...(r.assignment ? { assignment: r.assignment } : {}),
            ...(r.note ? { note: r.note } : {}),
          })),
        };
      })),
    });
  }
  return {
    $schema: 'https://schemas.openpark.io/inventory/v1.json',
    schemaVersion: 1,
    tenant: tenantSlug,
    exportedAt: now.toISOString(),
    slotTypes: tenant.slot_types,
    sites: out,
  };
}
