import { RateRules, computeFee } from '@openpark/core';
import { z } from 'zod';
import { audit } from '../db.js';
import { HttpError, created, defineRoute, boolQuery } from '../http.js';
import type { App } from '../server.js';

export function registerRateRoutes(app: App) {
  defineRoute(app, {
    method: 'GET', path: '/v1/rate-plans', summary: 'List plans (latest version of each unless all=true)', perm: 'read',
    query: z.object({ site: z.string().optional(), all: boolQuery() }),
    async handler({ db, query: q }) {
      return (await db.query(
        `select rp.id, st.code as site, rp.name, rp.version, rp.rules, rp.currency, rp.tax_mode, rp.active_from,
           (st.default_rate_plan_id = rp.id) as is_default,
           exists (select 1 from session s where s.rate_plan_id = rp.id) as in_use
         from rate_plan rp left join site st on st.id = rp.site_id
         where ($1::text is null or st.code = $1)
           and ($2 or rp.version = (select max(version) from rate_plan r2 where r2.site_id is not distinct from rp.site_id and r2.name = rp.name))
         order by rp.name, rp.version desc`, [q.site ?? null, q.all])).rows;
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/rate-plans', summary: 'Create a plan; a change to an existing name creates the next version', perm: 'rate_plan.edit',
    body: z.object({ site: z.string(), name: z.string().min(1), rules: RateRules, makeDefault: z.boolean().optional() }),
    async handler({ ctx, db, body }) {
      const site = (await db.query('select id, default_rate_plan_id from site where code = $1', [body.site])).rows[0];
      if (!site) throw new HttpError(404, 'site_not_found', `No site ${body.site}`);
      const currency = (await db.query('select currency from tenant')).rows[0].currency;
      const version = (await db.query('select coalesce(max(version), 0) + 1 as v from rate_plan where site_id = $1 and name = $2', [site.id, body.name])).rows[0].v;
      const r = await db.query(
        'insert into rate_plan (tenant_id, site_id, name, version, rules, currency, tax_mode) values ($1,$2,$3,$4,$5,$6,$7) returning id',
        [ctx.tenantId, site.id, body.name, version, JSON.stringify(body.rules), currency, body.rules.taxMode]);
      // New check-ins take the new version; open sessions keep the one they started under.
      if (body.makeDefault ?? true) await db.query('update site set default_rate_plan_id = $1 where id = $2', [r.rows[0].id, site.id]);
      await audit(db, ctx.tenantId, ctx.userId, 'rate_plan.create', 'rate_plan', null, { name: body.name, version });
      return created({ id: r.rows[0].id, version });
    },
  });

  defineRoute(app, {
    method: 'POST', path: '/v1/rate-plans/:id/quote', summary: 'Fee for a given in and out time, without a session', perm: 'read',
    body: z.object({ inAt: z.string().datetime({ offset: true }), outAt: z.string().datetime({ offset: true }), lostTicket: z.boolean().optional() }),
    async handler({ db, params, body }) {
      const plan = (await db.query('select rules, version, name from rate_plan where id = $1', [params.id])).rows[0];
      if (!plan) throw new HttpError(404, 'rate_plan_not_found', 'No such rate plan');
      try {
        return { plan: { name: plan.name, version: plan.version }, ...computeFee(RateRules.parse(plan.rules), new Date(body.inAt), new Date(body.outAt), { lostTicket: body.lostTicket }) };
      } catch (e) {
        if (e instanceof RangeError) throw new HttpError(400, 'bad_interval', e.message);
        throw e;
      }
    },
  });
}
