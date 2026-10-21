import { z } from 'zod';
import { audit } from '../db.js';
import { can } from '../auth.js';
import { HttpError, created, defineRoute } from '../http.js';
import type { App } from '../server.js';
import {
  NewPass, PassPolicy, cancelPass, createPass, getPass, listPasses, loadPolicy, lookupPass, redeemPass, regeneratePass,
} from '../services/passes.js';

const Device = { deviceId: z.string().uuid().optional(), gate: z.string().optional(), deviceAt: z.string().datetime({ offset: true }).optional() };

export function registerPassRoutes(app: App) {
  // ---- resident ---------------------------------------------------------------------------------
  defineRoute(app, {
    method: 'POST', path: '/v1/passes', summary: 'Create a guest pass (one active pass per unit); the QR is valid for 2 hours', perm: 'pass.own',
    body: NewPass, idempotent: true,
    handler: async ({ ctx, db, body }) => created(await createPass(app, db, ctx, body)),
  });

  defineRoute(app, {
    method: 'GET', path: '/v1/passes', summary: "A unit's recent passes (residents) or all passes (staff)", perm: 'me',
    query: z.object({ status: z.enum(['active', 'checked_in', 'completed', 'cancelled']).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }),
    handler: async ({ ctx, db, query }) => listPasses(app, db, ctx, can(ctx, 'pass.admin'), query.status, query.limit),
  });

  defineRoute(app, {
    method: 'GET', path: '/v1/passes/active', summary: "The unit's current pass with its QR, or null", perm: 'pass.own',
    async handler({ ctx, db }) {
      // Only the viewer's own unit's pass: a staff member with no unit has none (listPasses(…true) would return everyone's).
      const [p] = ctx.unitId ? await listPasses(app, db, ctx, false, undefined, 5).then((l) => l.filter((x) => x.status === 'active' || x.status === 'checked_in')) : [];
      const { policy, currency } = await loadPolicy(db);
      return { pass: p ?? null, policy: { qrTtlMin: policy.qrTtlMin, maxStayHours: policy.maxStayHours, overstayCharge: policy.overstayCharge, currency } };
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/passes/:id/regenerate', summary: 'New QR (another 2 hours) for a pass whose guest has not checked in', perm: 'me', idempotent: true,
    handler: async ({ ctx, db, params }) => regeneratePass(app, db, ctx, (p) => can(ctx, p), params.id!),
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/passes/:id/cancel', summary: 'Cancel a pass that has not been checked in', perm: 'me', idempotent: true,
    handler: async ({ ctx, db, params }) => cancelPass(app, db, ctx, (p) => can(ctx, p), params.id!),
  });

  // ---- attendant --------------------------------------------------------------------------------
  defineRoute(app, {
    method: 'GET', path: '/v1/passes/lookup', summary: 'Scanner preview: who a QR is for and whether it can be redeemed', perm: 'pass.redeem',
    query: z.object({ token: z.string().min(10) }),
    handler: async ({ db, query }) => lookupPass(app, db, query.token),
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/passes/redeem', summary: 'Scan a guest pass at the gate: opens a free session', perm: 'pass.redeem', idempotent: true,
    body: z.object({
      token: z.string().min(10), site: z.string(),
      plate: z.object({ display: z.string().min(1).max(20), region: z.string().optional() }),
      vehicle: z.object({ bodyType: z.string().optional(), make: z.string().optional(), model: z.string().optional(), color: z.string().optional(), year: z.number().int().optional() }).optional(),
      slot: z.string().optional(),
      source: z.enum(['manual', 'ai_assist', 'ai_auto']).default('manual'),
      read: z.object({ textRaw: z.string().optional(), confidence: z.number().min(0).max(1).optional(), engine: z.string().optional(), latencyMs: z.number().int().optional(), cropKey: z.string().optional() }).optional(),
      ...Device,
    }),
    handler: async ({ ctx, db, body, after }) => created(await redeemPass(app, db, ctx, after, body)),
  });

  // ---- admin ------------------------------------------------------------------------------------
  defineRoute(app, {
    method: 'GET', path: '/v1/passes/:id', summary: 'One pass', perm: 'pass.admin',
    handler: async ({ db, params }) => getPass(app, db, params.id!, app.now(), false),
  });

  defineRoute(app, {
    method: 'GET', path: '/v1/pass-policy', summary: 'Guest-pass rules for this tenant', perm: 'read',
    handler: async ({ db }) => (await loadPolicy(db)),
  });

  defineRoute(app, {
    method: 'PATCH', path: '/v1/pass-policy', summary: 'Change guest-pass rules (QR lifetime, stay limit, reminders, overstay charge, alert recipients)', perm: 'settings.edit',
    body: z.record(z.unknown()),
    async handler({ ctx, db, body }) {
      const before = await loadPolicy(db);
      const parsed = PassPolicy.safeParse({ ...before.policy, ...body });
      if (!parsed.success) throw new HttpError(400, 'validation_failed', 'Invalid pass policy', parsed.error.issues);
      await db.query("update tenant set settings = settings || jsonb_build_object('passPolicy', $1::jsonb)", [JSON.stringify(parsed.data)]);
      await audit(db, ctx.tenantId, ctx.userId, 'pass_policy.update', 'tenant', before.policy, parsed.data);
      return { policy: parsed.data };
    },
  });
}
