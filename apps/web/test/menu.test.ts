import { describe, expect, it } from 'vitest';
import type { Role } from '../src/app-context.js';
import { buildMenu } from '../src/menu.js';

const menu = (roles: Role[], superadmin = false, slug: string | null = 'acme') => buildMenu({ slug, roles, superadmin });
const ids = (roles: Role[], superadmin = false, slug: string | null = 'acme') => menu(roles, superadmin, slug).map((g) => g.id);
const adminItems = (roles: Role[], sa = false) => menu(roles, sa).find((g) => g.id === 'admin')?.items.map((i) => i.id);
const ADMIN_ITEMS = ['rates', 'parking', 'inventory', 'units', 'users', 'integrations', 'ai', 'locale'];

describe('menu by roles', () => {
  it('residents see only the resident view', () => expect(ids(['resident'])).toEqual(['resident']));
  it('attendants see only the operator view', () => expect(ids(['attendant'])).toEqual(['operator']));
  it('supervisors are attendants who also see the platform view', () => expect(ids(['supervisor'])).toEqual(['platform', 'operator']));
  it('admins see the platform view and the Admin group', () => expect(ids(['admin'])).toEqual(['platform', 'admin']));
  it('combines the views of every role a person holds', () => {
    expect(ids(['resident', 'attendant'])).toEqual(['resident', 'operator']);
    expect(ids(['resident', 'admin'])).toEqual(['resident', 'platform', 'admin']);
  });
  it('only admins and super admins get the Admin group', () => {
    for (const r of ['resident', 'attendant', 'supervisor'] as Role[]) expect(adminItems([r])).toBeUndefined();
    expect(adminItems(['admin'])).toBeDefined();
  });
  it('puts every admin-only item under Admin, and Organisations only for super admins', () => {
    expect(adminItems(['admin'])).toEqual(ADMIN_ITEMS);
    expect(adminItems(['admin'], true)).toEqual([...ADMIN_ITEMS, 'organisations']);
  });
  it('keeps admin-only pages out of the platform view', () => {
    const platform = menu(['admin']).find((g) => g.id === 'platform')!.items.map((i) => i.id);
    expect(platform).toEqual(['dashboard', 'sessions', 'slots', 'passes', 'queue']);
    for (const a of ADMIN_ITEMS) expect(platform).not.toContain(a);
  });
  it('lets the attendant reach the sync queue from the operator view', () => {
    expect(menu(['attendant'])[0]!.items.map((i) => i.id)).toEqual(['home', 'checkin', 'checkout', 'queue']);
  });
  it('gives a super admin without an organisation only the Organisations page', () => {
    const m = menu([], true, null);
    expect(m.map((g) => g.id)).toEqual(['admin']);
    expect(m[0]!.items).toEqual([{ id: 'organisations', labelKey: 'platform.tenants', to: '/platform' }]);
  });
  it('shows a super admin inside any property the platform and admin groups', () => expect(ids([], true)).toEqual(['platform', 'admin']));
  it('shows nothing to someone with no role and no super admin flag', () => expect(menu([], false, null)).toEqual([]));
  it('links every item under the organisation slug', () => {
    for (const g of menu(['admin'])) for (const i of g.items) expect(i.to.startsWith('/t/acme/')).toBe(true);
  });
});
