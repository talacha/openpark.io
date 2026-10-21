import type { Role } from './app-context.js';

export interface MenuItem { id: string; labelKey: string; to: string }
export interface MenuGroup {
  id: 'resident' | 'platform' | 'operator' | 'admin';
  labelKey: string;
  /** Where the group's heading links to (its first page). */
  to: string;
  items: MenuItem[];
}

const has = (roles: Role[], ...any: Role[]) => any.some((r) => roles.includes(r));

/** Roles are cumulative; a Super Admin (platform-wide flag) has every area. */
export const isOps = (roles: Role[], superadmin: boolean) => superadmin || has(roles, 'supervisor', 'admin');
export const isAdmin = (roles: Role[], superadmin: boolean) => superadmin || has(roles, 'admin');
export const isOperator = (roles: Role[], superadmin = false) => superadmin || has(roles, 'attendant', 'supervisor', 'admin');
/** Admins and Super Admins can open the Resident view to see what residents see (a unit is needed to use it). */
export const hasResidentView = (roles: Role[], superadmin: boolean) => superadmin || has(roles, 'resident', 'admin');
/** Anyone who is not only a resident may use the staff screens (queue, check-in by link). */
export const isStaff = (roles: Role[], superadmin: boolean) => superadmin || roles.some((r) => r !== 'resident');

/**
 * The one menu used on every screen and device. Which groups appear depends only on the person's roles (a person can hold several):
 *  - Resident view: residents
 *  - Platform view (operations): supervisors, admins and super admins
 *  - Operator view (check in / check out): attendants and supervisors
 *  - Admin: admins and platform super admins, with everything that is admin-only as sub-items
 */
export function buildMenu({ slug, roles, superadmin }: { slug: string | null; roles: Role[]; superadmin: boolean }): MenuGroup[] {
  const base = slug ? `/t/${slug}` : '';
  const groups: MenuGroup[] = [];

  if (slug && hasResidentView(roles, superadmin)) groups.push({ id: 'resident', labelKey: 'nav.resident', to: `${base}/r`, items: [] });

  if (slug && isOps(roles, superadmin)) {
    groups.push({
      id: 'platform', labelKey: 'nav.platformView', to: `${base}/dashboard`,
      items: [
        { id: 'dashboard', labelKey: 'nav.dashboard', to: `${base}/dashboard` },
        { id: 'sessions', labelKey: 'nav.sessions', to: `${base}/sessions` },
        { id: 'slots', labelKey: 'nav.slots', to: `${base}/slots` },
        { id: 'passes', labelKey: 'nav.passes', to: `${base}/passes` },
        { id: 'queue', labelKey: 'nav.queue', to: `${base}/queue` },
      ],
    });
  }

  if (slug && isOperator(roles, superadmin)) {
    groups.push({
      id: 'operator', labelKey: 'nav.operatorView', to: `${base}/a`,
      items: [
        { id: 'home', labelKey: 'att.home', to: `${base}/a` },
        { id: 'checkin', labelKey: 'att.checkin', to: `${base}/a/checkin` },
        { id: 'checkout', labelKey: 'att.checkout', to: `${base}/a/checkout` },
        { id: 'queue', labelKey: 'nav.queue', to: `${base}/queue` },
      ],
    });
  }

  if (isAdmin(roles, superadmin)) {
    const items: MenuItem[] = slug ? [
      { id: 'rates', labelKey: 'nav.rates', to: `${base}/rates` },
      { id: 'parking', labelKey: 'nav.parking', to: `${base}/parking` },
      { id: 'inventory', labelKey: 'nav.inventory', to: `${base}/inventory` },
      { id: 'units', labelKey: 'nav.units', to: `${base}/units` },
      { id: 'users', labelKey: 'nav.users', to: `${base}/users` },
      { id: 'integrations', labelKey: 'nav.integrations', to: `${base}/integrations` },
      { id: 'ai', labelKey: 'nav.ai', to: `${base}/ai` },
      { id: 'locale', labelKey: 'nav.locale', to: `${base}/locale` },
    ] : [];
    if (superadmin) items.push({ id: 'organisations', labelKey: 'platform.tenants', to: '/platform' });
    if (items.length) groups.push({ id: 'admin', labelKey: 'nav.adminGroup', to: items[0]!.to, items });
  }
  return groups;
}
