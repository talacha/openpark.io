import { z } from 'zod';
import { created, defineRoute } from '../http.js';
import type { App } from '../server.js';
import { appendReportEvidence, flagVehicle, inspectVehicle, issueFine, listReports } from '../services/enforcement.js';

const Entry = z.string().trim().min(1).max(2048);

export function registerEnforcementRoutes(app: App) {
  defineRoute(app, {
    method: 'GET', path: '/v1/enforcement/inspect', summary: 'Inspect a vehicle for parking enforcement', perm: 'enforcement',
    query: z.object({ site: z.string(), entry: Entry }),
    handler: async ({ app, db, ctx, query }) => inspectVehicle(app, db, ctx, query.site, query.entry),
  });

  defineRoute(app, {
    method: 'GET', path: '/v1/enforcement/reports', summary: 'List enforcement reports and required actions', perm: 'enforcement.process',
    query: z.object({ site: z.string().optional(), status: z.enum(['open', 'all']).default('open'), limit: z.coerce.number().int().min(1).max(100).default(50) }),
    handler: async ({ app, db, ctx, query }) => listReports(app, db, ctx, query),
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/enforcement/flags', summary: 'Flag a parking violation', perm: 'enforcement', idempotent: true,
    body: z.object({
      site: z.string(), entry: Entry, action: z.enum(['fine', 'immobilization']),
      evidence: z.object({ contentType: z.enum(['image/jpeg']), dataBase64: z.string().min(1) }).optional(),
    }),
    handler: async ({ app, db, ctx, body }) => created(await flagVehicle(app, db, ctx, body)),
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/enforcement/cases/:id/fine', summary: 'Issue a linked department fine', perm: 'enforcement.process', idempotent: true,
    handler: async ({ app, db, ctx, params }) => issueFine(app, db, ctx, params.id!),
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/enforcement/cases/:id/evidence', summary: 'Append report evidence or confirm immobilization', perm: 'enforcement.process', idempotent: true,
    body: z.object({ contentType: z.enum(['image/jpeg']), dataBase64: z.string().min(1), immobilize: z.boolean().default(false) }),
    handler: async ({ app, db, ctx, params, body }) => created(await appendReportEvidence(app, db, ctx, params.id!, body)),
  });
}
