import { describe, expect, it } from 'vitest';
import type { Role } from '../src/app-context.js';
import { buildMenu, hasResidentView } from '../src/menu.js';

const menu = (roles: Role[], superadmin = false, slug: string | null = 'acme') => buildMenu({ slug, roles, superadmin });
const ids = (roles: Role[], superadmin = false, slug: string | null = 'acme') => menu(roles, superadmin, slug).map((g) => g.id);
const adminItems = (roles: Role[], sa = false) => menu(roles, sa).find((g) => g.id === 'admin')?.items.map((i) => i.id);
// Reshaped admin surface (FEAT-005): primary entities + one Bulk import/export, then an Advanced group (Rates,
// Integrations, AI). The Localization entry is removed — the product surfaces es-MX + en from code.
const ADMIN_ITEMS = ['parking', 'units', 'users', 'bulkio', 'rates', 'integrations', 'ai'];
const ADVANCED = ['rates', 'integrations', 'ai'];

describe('menu by roles', () => {
  it('residents see only the resident view', () => expect(ids(['resident'])).toEqual(['resident']));
  it('the resident view is a group with Edit profile and Issue new parking pass child links', () => {
    const resident = menu(['resident']).find((g) => g.id === 'resident')!;
    expect(resident.items.map((i) => i.id)).toEqual(['profile', 'newpass']);
    expect(resident.items.map((i) => i.to)).toEqual(['/t/acme/r?edit=1', '/t/acme/r#new']);
    expect(resident.items.map((i) => i.labelKey)).toEqual(['nav.editProfile', 'nav.newPass']);
  });
  it('attendants see only the operator view', () => expect(ids(['attendant'])).toEqual(['operator']));
  it('supervisors are attendants who also see enforcement and the platform view', () => expect(ids(['supervisor'])).toEqual(['enforcement', 'platform', 'operator']));
  it('offers enforcement only to supervisors', () => {
    for (const r of ['resident', 'attendant', 'admin'] as Role[]) expect(ids([r])).not.toContain('enforcement');
    expect(ids([], true)).not.toContain('enforcement');
  });
  it('admins see the platform and operator views and the Admin group, but not the resident view', () => expect(ids(['admin'])).toEqual(['platform', 'operator', 'admin']));
  it('combines the views of every role a person holds', () => {
    expect(ids(['resident', 'attendant'])).toEqual(['resident', 'operator']);
    expect(ids(['resident', 'admin'])).toEqual(['resident', 'platform', 'operator', 'admin']);
  });
  it('only admins and super admins get the Admin group', () => {
    for (const r of ['resident', 'attendant', 'supervisor'] as Role[]) expect(adminItems([r])).toBeUndefined();
    expect(adminItems(['admin'])).toBeDefined();
  });
  it('puts every admin-only item under Admin, and Organisations only for super admins', () => {
    expect(adminItems(['admin'])).toEqual(ADMIN_ITEMS);
    expect(adminItems(['admin'], true)).toEqual([...ADMIN_ITEMS, 'organisations']);
  });
  it('drops the Localization admin entry (locale is code-controlled now) and keeps a Bulk import/export entry', () => {
    const items = adminItems(['admin'])!;
    expect(items).not.toContain('locale');
    expect(items).toContain('bulkio');
  });
  it('ends the admin group with the Advanced items (Rates, Integrations, AI) after the primary entities', () => {
    const items = adminItems(['admin'])!;
    expect(items.slice(-ADVANCED.length)).toEqual(ADVANCED);
    expect(items.slice(0, items.length - ADVANCED.length)).toEqual(['parking', 'units', 'users', 'bulkio']);
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
  it('shows a super admin inside any property every staff view, but not the resident view', () => expect(ids([], true)).toEqual(['platform', 'operator', 'admin']));
  it('opens the resident view only to users holding the resident role', () => {
    expect(hasResidentView(['resident'], false)).toBe(true);
    expect(hasResidentView(['resident', 'admin'], false)).toBe(true);
    expect(hasResidentView(['admin'], false)).toBe(false);
    expect(hasResidentView(['supervisor'], false)).toBe(false);
    expect(hasResidentView(['attendant'], false)).toBe(false);
    expect(hasResidentView([], true)).toBe(false);
    expect(hasResidentView(['admin'], true)).toBe(false);
  });
  it('shows nothing to someone with no role and no super admin flag', () => expect(menu([], false, null)).toEqual([]));
  it('links every item under the organisation slug', () => {
    for (const g of menu(['admin'])) for (const i of g.items) expect(i.to.startsWith('/t/acme/')).toBe(true);
  });
});
