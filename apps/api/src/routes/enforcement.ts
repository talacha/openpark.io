import { z } from 'zod';
import { created, defineRoute } from '../http.js';
import type { App } from '../server.js';
import { flagVehicle, inspectVehicle } from '../services/enforcement.js';

const Entry = z.string().trim().min(1).max(2048);

export function registerEnforcementRoutes(app: App) {
  defineRoute(app, {
    method: 'GET', path: '/v1/enforcement/inspect', summary: 'Inspect a vehicle for parking enforcement', perm: 'enforcement',
    query: z.object({ site: z.string(), entry: Entry }),
    handler: async ({ app, db, ctx, query }) => inspectVehicle(app, db, ctx, query.site, query.entry),
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/enforcement/flags', summary: 'Flag a parking violation', perm: 'enforcement', idempotent: true,
    body: z.object({
      site: z.string(), entry: Entry, action: z.enum(['fine', 'immobilization']),
      evidence: z.object({ contentType: z.enum(['image/jpeg']), dataBase64: z.string().min(1) }).optional(),
    }),
    handler: async ({ app, db, ctx, body }) => created(await flagVehicle(app, db, ctx, body)),
  });
}
