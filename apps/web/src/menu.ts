import type { Role } from './app-context.js';

/** A short identifier for the inline-SVG icon a destination shows when the sidebar is collapsed (see AppMenu). A default covers anything unset. */
export type MenuIcon = 'resident' | 'platform' | 'operator' | 'admin';

export interface MenuItem { id: string; labelKey: string; to: string; icon?: MenuIcon }
export interface MenuGroup {
  id: 'resident' | 'enforcement' | 'platform' | 'operator' | 'admin';
  labelKey: string;
  /** Where the group's heading links to (its first page). */
  to: string;
  /** The icon shown for this group's top-level destination when the sidebar is collapsed. */
  icon?: MenuIcon;
  items: MenuItem[];
}

const has = (roles: Role[], ...any: Role[]) => any.some((r) => roles.includes(r));

/** Roles are cumulative; a Super Admin (platform-wide flag) has every staff area. */
export const isOps = (roles: Role[], superadmin: boolean) => superadmin || has(roles, 'supervisor', 'admin');
export const isAdmin = (roles: Role[], superadmin: boolean) => superadmin || has(roles, 'admin');
export const isOperator = (roles: Role[], superadmin = false) => superadmin || has(roles, 'attendant', 'supervisor', 'admin');
/** Only residents open the Parking passes screen; staff roles and Super Admins do not get it by default (a unit is needed to use it). */
export const hasResidentView = (roles: Role[], _superadmin: boolean) => has(roles, 'resident');
/** Vehicle enforcement is a supervisor-only mode; other staff roles and the platform flag alone do not grant it. */
export const hasEnforcement = (roles: Role[]) => has(roles, 'supervisor');
/** Anyone who is not only a resident may use the staff screens (queue, check-in by link). */
export const isStaff = (roles: Role[], superadmin: boolean) => superadmin || roles.some((r) => r !== 'resident');

/**
 * The one menu used on every screen and device. Which groups appear depends only on the person's roles (a person can hold several):
 *  - Parking passes: residents
 *  - Enforcement: supervisors only
 *  - Platform view (operations): supervisors, admins and super admins
 *  - Operator view (check in / check out): attendants and supervisors
 *  - Admin: admins and platform super admins, with everything that is admin-only as sub-items
 */
export function buildMenu({ slug, roles, superadmin }: { slug: string | null; roles: Role[]; superadmin: boolean }): MenuGroup[] {
  const base = slug ? `/t/${slug}` : '';
  const groups: MenuGroup[] = [];

  if (slug && hasResidentView(roles, superadmin)) groups.push({
    id: 'resident', labelKey: 'nav.parkingPasses', to: `${base}/r#new`, icon: 'resident', items: [],
  });

  if (slug && hasEnforcement(roles)) groups.push({
    id: 'enforcement', labelKey: 'nav.enforcement', to: `${base}/enforcement`, icon: 'platform', items: [],
  });

  if (slug && isOps(roles, superadmin)) {
    groups.push({
      id: 'platform', labelKey: 'nav.platformView', to: `${base}/dashboard`, icon: 'platform',
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
      id: 'operator', labelKey: 'nav.operatorView', to: `${base}/a`, icon: 'operator',
      items: [
        { id: 'home', labelKey: 'att.home', to: `${base}/a` },
        { id: 'checkin', labelKey: 'att.checkin', to: `${base}/a/checkin` },
        { id: 'checkout', labelKey: 'att.checkout', to: `${base}/a/checkout` },
        { id: 'queue', labelKey: 'nav.queue', to: `${base}/queue` },
      ],
    });
  }

  if (isAdmin(roles, superadmin)) {
    // Net admin surface per the reshaped terminology: the primary entities (Communities & parking, Units, Users) and
    // one Bulk import/export screen, then an Advanced group (Rates, Integrations, AI). Localization is removed — the
    // product surfaces es-MX + en in code (see i18n.ts SELECTABLE_LOCALES).
    const items: MenuItem[] = slug ? [
      { id: 'parking', labelKey: 'nav.parking', to: `${base}/parking` },
      { id: 'units', labelKey: 'nav.units', to: `${base}/units` },
      { id: 'users', labelKey: 'nav.users', to: `${base}/users` },
      { id: 'bulkio', labelKey: 'nav.bulkio', to: `${base}/bulk` },
      // Advanced: operational settings kept but demoted (flagged design decisions, not primary entities).
      { id: 'rates', labelKey: 'nav.rates', to: `${base}/rates` },
      { id: 'integrations', labelKey: 'nav.integrations', to: `${base}/integrations` },
      { id: 'ai', labelKey: 'nav.ai', to: `${base}/ai` },
    ] : [];
    if (superadmin) items.push({ id: 'organisations', labelKey: 'platform.tenants', to: '/platform' });
    if (items.length) groups.push({ id: 'admin', labelKey: 'nav.adminGroup', to: items[0]!.to, icon: 'admin', items });
  }
  return groups;
}
