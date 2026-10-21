import { InventoryDoc, flattenInventory, diffInventory, type InventoryDiff } from '@openpark/core';
import { z } from 'zod';
import { audit } from '../db.js';
import { locateJsonError } from '../jsonpos.js';
import { HttpError, created, defineRoute, boolQuery } from '../http.js';
import type { App } from '../server.js';
import { applyInventory, applySlots, exportInventory, loadLiveSlots, previewImport } from '../services/inventory.js';

const summary = (d: InventoryDiff) => ({ added: d.added.length, changed: d.changed.length, retired: d.retired.length, conflicts: d.conflicts.length });

/** Accepts the document itself, or `{ text }` holding raw JSON so parse errors get a line and column. */
function parseDoc(raw: unknown): InventoryDoc {
  let value = raw;
  if (raw && typeof raw === 'object' && 'text' in raw && typeof (raw as { text: unknown }).text === 'string') {
    const text = (raw as { text: string }).text;
    try {
      value = JSON.parse(text);
    } catch (e) {
      const at = locateJsonError(text);
      throw new HttpError(400, 'invalid_json', at ? at.message : (e as Error).message, at ? { line: at.line, column: at.column } : undefined);
    }
  }
  const r = InventoryDoc.safeParse(value);
  if (!r.success) {
    throw new HttpError(400, 'schema_invalid', 'Inventory does not match schema v1',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  try {
    flattenInventory(r.data);
  } catch (e) {
    throw new HttpError(400, 'range_invalid', (e as Error).message);
  }
  return r.data;
}

export function registerInventoryRoutes(app: App) {
  defineRoute(app, {
    method: 'GET', path: '/v1/inventory/export', summary: 'Inventory JSON', perm: 'read',
    query: z.object({ site: z.string().optional(), zone: z.string().optional() }),
    async handler({ ctx, db, query }) {
      if (ctx.siteId) { // a key limited to one site exports only that site
        const code = (await db.query('select code from site where id = $1', [ctx.siteId])).rows[0]?.code;
        if (query.site && query.site !== code) throw new HttpError(404, 'site_not_found', `No site ${query.site}`);
        query = { ...query, site: code };
      }
      return exportInventory(db, ctx.tenantSlug, app.now(), query);
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/inventory/import', summary: 'Validate and diff; returns a job', perm: 'inventory.import',
    query: z.object({ mode: z.enum(['merge', 'replace']).default('merge'), dryRun: boolQuery() }),
    body: z.record(z.unknown()),
    async handler({ ctx, db, query, body }) {
      const doc = parseDoc(body);
      const diff = previewImport(await loadLiveSlots(db), doc, query.mode);
      const job = (await db.query(
        'insert into inventory_import (tenant_id, mode, doc, diff, created_by) values ($1,$2,$3,$4,$5) returning id',
        [ctx.tenantId, query.mode, JSON.stringify(doc), JSON.stringify({ ...diff, dryRun: query.dryRun }), ctx.userId])).rows[0];
      return created({ job: job.id, mode: query.mode, dryRun: query.dryRun, summary: summary(diff), diff });
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/inventory/import/:job/apply', summary: 'Apply a previewed diff', perm: 'inventory.import',
    async handler({ ctx, db, params }) {
      const job = (await db.query("select * from inventory_import where id = $1 and kind = 'inventory' for update", [params.job])).rows[0];
      if (!job) throw new HttpError(404, 'job_not_found', 'No such import job');
      if (job.diff.dryRun) throw new HttpError(409, 'dry_run', 'This job was a dry run; submit the import again without dryRun');
      if (job.status !== 'previewed') throw new HttpError(409, 'not_previewed', `Job is ${job.status}`);
      const live = await loadLiveSlots(db);
      const doc = InventoryDoc.parse(job.doc);
      // Live state may have moved since the preview, so the diff is recomputed and re-checked.
      const diff = previewImport(live, doc, job.mode);
      if (diff.conflicts.length) throw new HttpError(409, 'conflicts', 'Occupied or permit-assigned slots would be removed', diff.conflicts);
      await applyInventory(db, ctx.tenantId, doc, diff);
      await db.query("update inventory_import set status = 'applied', snapshot = $2, applied_at = now() where id = $1", [job.id, JSON.stringify(live)]);
      await audit(db, ctx.tenantId, ctx.userId, 'inventory.import', `inventory_import:${job.id}`, null, { mode: job.mode, ...summary(diff) });
      return { job: job.id, applied: summary(diff) };
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/inventory/import/:job/rollback', summary: 'Restore the pre-import snapshot', perm: 'inventory.import',
    async handler({ ctx, db, params }) {
      const job = (await db.query("select * from inventory_import where id = $1 and kind = 'inventory' for update", [params.job])).rows[0];
      if (!job) throw new HttpError(404, 'job_not_found', 'No such import job');
      if (job.status !== 'applied') throw new HttpError(409, 'not_applied', `Job is ${job.status}`);
      const diff = diffInventory(await loadLiveSlots(db), job.snapshot, 'replace');
      if (diff.conflicts.length) throw new HttpError(409, 'conflicts', 'Slots created by the import are occupied or assigned', diff.conflicts);
      await applySlots(db, ctx.tenantId, diff);
      await db.query("update inventory_import set status = 'rolled_back' where id = $1", [job.id]);
      await audit(db, ctx.tenantId, ctx.userId, 'inventory.rollback', `inventory_import:${job.id}`, null, summary(diff));
      return { job: job.id, rolledBack: summary(diff) };
    },
  });
}
