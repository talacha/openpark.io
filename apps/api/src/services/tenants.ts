import { randomBytes } from 'node:crypto';
import { hashPassword } from '../auth.js';
import { audit } from '../db.js';
import { HttpError } from '../http.js';
import type { App } from '../server.js';
import { COUNTRIES, DEFAULT_COUNTRY, demoInventory } from './demo.js';
import { applyInventory, loadLiveSlots, previewImport } from './inventory.js';
import { DEFAULT_POLICY } from './passes.js';

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'org';

/** Who owns the new organisation. */
export type Owner =
  | { kind: 'user'; userId: string; name?: string }
  | { kind: 'new_local_user'; email: string; name?: string; password: string }
  | { kind: 'invite'; email: string };

export interface Provisioned { slug: string; tenantId: string; locale: string; currency: string; ownerId: string | null }

/**
 * Create an organisation with its country defaults: demo site, starter rate plan, guest-pass rules (2 h QR, 12 h stay,
 * reminders at 10 h and 11 h, and the 5,000 MXN HOA overstay charge for Mexico) and its first owner.
 * Shared by self-service signup and by platform admins creating organisations for invited testers.
 */
export async function provisionTenant(app: App, input: { organisation: string; country: string; slug?: string; owner: Owner }): Promise<Provisioned> {
  const c = COUNTRIES[input.country] ?? DEFAULT_COUNTRY;
  const baseSlug = input.slug ?? slugify(input.organisation);

  let tenantId = '', slug = baseSlug;
  for (let attempt = 0; ; attempt++) {
    try {
      tenantId = (await app.db.raw((db) => db.query('select create_tenant($1,$2,$3,$4,$5,$6,$7) as id',
        [slug, input.organisation, input.country, c.locale, c.currency, c.timezone, c.plateRegions]))).rows[0].id;
      break;
    } catch (e) {
      if ((e as { code?: string }).code !== '23505' || input.slug || attempt > 4) {
        if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'slug_taken', 'That tenant slug is taken');
        throw e;
      }
      slug = `${baseSlug}-${randomBytes(2).toString('hex')}`;
    }
  }

  const ownerId = await app.db.withTenant(tenantId, async (db) => {
    let id: string | null = null;
    const o = input.owner;
    if (o.kind === 'new_local_user') {
      id = (await db.query('insert into app_user (email, name, password_hash, locale) values ($1,$2,$3,$4) returning id', [o.email, o.name ?? null, await hashPassword(o.password), c.locale])).rows[0].id as string;
    } else if (o.kind === 'user') {
      id = o.userId;
      if (o.name) await db.query('update app_user set name = coalesce(name, $2) where id = $1', [id, o.name]);
    } else {
      await db.query("insert into membership_invite (tenant_id, email, roles) values ($1,$2,array['admin'])", [tenantId, o.email.toLowerCase()]);
    }
    if (id) await db.query("insert into membership (tenant_id, user_id, roles) values ($1,$2,array['admin'])", [tenantId, id]);

    const doc = demoInventory(slug, c.timezone);
    await applyInventory(db, tenantId, doc, previewImport(await loadLiveSlots(db), doc, 'merge'));
    const site = (await db.query('select id from site where code = $1', ['DEMO-01'])).rows[0].id;
    const plan = await db.query(
      `insert into rate_plan (tenant_id, site_id, name, version, rules, currency, tax_mode) values ($1,$2,'Visitor hourly',1,$3,$4,$5) returning id`,
      [tenantId, site, JSON.stringify(c.rules), c.currency, c.rules.taxMode]);
    await db.query('update site set default_rate_plan_id = $1 where id = $2', [plan.rows[0].id, site]);
    // Overstay default is keyed off the tenant CURRENCY, not the country: MXN tenants seed the 5,000 MXN HOA
    // charge (500000 minor units), every other currency seeds 0. It stays a configurable policy editable via
    // PATCH /v1/pass-policy — not a hardcoded or enforced fine.
    await db.query("update tenant set settings = settings || jsonb_build_object('passPolicy', $1::jsonb)",
      [JSON.stringify({ ...DEFAULT_POLICY, overstayCharge: c.currency === 'MXN' ? 500000 : 0 })]);
    await audit(db, tenantId, id, 'tenant.signup', 'tenant', null, { slug, country: input.country, owner: o.kind });
    return id;
  });
  return { slug, tenantId, locale: c.locale, currency: c.currency, ownerId };
}
