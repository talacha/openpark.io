import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useApp, type PlatformTenant } from '../app-context.js';
import { useApi } from './hooks.js';
import { NAMES, SELECTABLE_LOCALES, useI18n, useT } from '../i18n.js';
import { buildMenu, type MenuGroup, type MenuIcon } from '../menu.js';
import { SyncBadge } from './SyncBadge.js';

const KEY = 'op.menu.open';
const readOpen = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, boolean>; } catch { return {}; } };

function Chevron() {
  return <svg className="chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>;
}

/** One inline-SVG per menu destination, shown when the sidebar is collapsed. Reuses the Chevron/burger inline-SVG approach — no icon-font dependency. A default covers anything unset. */
function MenuIconGlyph({ icon }: { icon?: MenuIcon }) {
  const p = (() => {
    switch (icon) {
      case 'resident': return <path d="M3 11l9-7 9 7M5 10v10h14V10" />;        // house
      case 'platform': return <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />;   // bar chart
      case 'operator': return <path d="M3 7h13l5 5v5h-3M3 17h3M9 17h7M6 20a2 2 0 100-4 2 2 0 000 4zM18 20a2 2 0 100-4 2 2 0 000 4z" />; // vehicle
      case 'admin': return <path d="M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1l2-1.6-2-3.4-2.4 1a7 7 0 00-1.7-1l-.4-2.5H9.6L9.2 5a7 7 0 00-1.7 1l-2.4-1-2 3.4 2 1.6a7 7 0 000 2l-2 1.6 2 3.4 2.4-1a7 7 0 001.7 1l.4 2.5h4.8l.4-2.5a7 7 0 001.7-1l2.4 1 2-3.4-2-1.6a7 7 0 00.1-1z" />; // gear
      case 'profile': return <path d="M12 12a4 4 0 100-8 4 4 0 000 8zM5 21a7 7 0 0114 0" />; // person
      case 'newpass': return <path d="M12 5v14M5 12h14" />;                     // plus
      default: return <circle cx="12" cy="12" r="8" />;
    }
  })();
  return <svg className="menu-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p}</svg>;
}

/**
 * The single navigation menu: the same component and structure on every screen and device (sidebar on wide screens,
 * a drawer on phones). What it contains depends only on the person's role (see menu.ts).
 */
export function AppMenu({ onNavigate, collapsed = false, onToggleCollapsed }: { onNavigate?: () => void; collapsed?: boolean; onToggleCollapsed?: () => void }) {
  const t = useT();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const { me, who, sites, site, setSiteCode, signOut, switchTenant } = useApp();
  const { locale, setLocale } = useI18n();
  const groups = buildMenu({ slug: me?.tenant.slug ?? null, roles: me?.roles ?? [], superadmin: !!who?.superadmin });
  // A Super Admin can switch between ALL properties, not just ones they belong to.
  const allTenants = useApi<PlatformTenant[]>(who?.superadmin ? '/v1/platform/tenants' : null);
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen);

  const active = (g: MenuGroup) => g.items.some((i) => pathname === i.to || pathname.startsWith(`${i.to}/`));
  // The group you are in is always expanded, so the current page is never hidden.
  useEffect(() => {
    const here = groups.find(active);
    if (here && !open[here.id]) setOpen((o) => ({ ...o, [here.id]: true }));
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => setOpen((o) => { const n = { ...o, [id]: !o[id] }; try { localStorage.setItem(KEY, JSON.stringify(n)); } catch { /* private mode */ } return n; });

  // Clicking a group's head: when collapsed, expand the whole sidebar first and open that group (no hover-only flyout).
  const onHead = (id: string) => {
    if (collapsed) { onToggleCollapsed?.(); setOpen((o) => ({ ...o, [id]: true })); return; }
    toggle(id);
  };

  return (
    <aside className="side menu" id="app-menu" aria-label={t('nav.menu')}>
      <div className="brand"><img src="/icon.svg" alt="" width="24" height="24" /><span className="menu-label">{t('app.name')}</span>{onToggleCollapsed && <button type="button" className="menu-collapse" aria-expanded={!collapsed} aria-controls="app-menu" aria-label={collapsed ? t('nav.expand') : t('nav.collapse')} title={collapsed ? t('nav.expand') : t('nav.collapse')} onClick={onToggleCollapsed}><Chevron /></button>}</div>
      {me && <div className="menu-org menu-label">{me.tenant.name}</div>}
      {me && (who?.superadmin || (who?.memberships.length ?? 0) > 1) && (
        <select className="menu-label" aria-label={who?.superadmin ? t('nav.property') : t('nav.tenant')} value={me.tenant.slug} onChange={async (e) => { await switchTenant(e.target.value); onNavigate?.(); nav('/'); }}>
          {(who?.superadmin && allTenants.data ? allTenants.data : who!.memberships).map((m) => <option key={m.slug} value={m.slug}>{m.name}</option>)}
        </select>
      )}
      {sites.length > 1 && (
        <select className="menu-label" aria-label={t('common.site')} value={site?.code} onChange={(e) => setSiteCode(e.target.value)}>
          {sites.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </select>
      )}

      <nav className="menu-nav" aria-label={t('nav.menu')}>
        {groups.map((g) => g.items.length === 0 ? (
          <NavLink key={g.id} className="nav menu-link menu-top" to={g.to} onClick={onNavigate} title={collapsed ? t(g.labelKey) : undefined} aria-label={t(g.labelKey)}>
            <MenuIconGlyph icon={g.icon} /><span className="menu-label">{t(g.labelKey)}</span>
          </NavLink>
        ) : (
          <div key={g.id} className="menu-group" data-group={g.id}>
            <button type="button" className="menu-head" aria-expanded={collapsed ? false : !!open[g.id]} aria-controls={`menu-${g.id}`} data-active={active(g)} onClick={() => onHead(g.id)} title={collapsed ? t(g.labelKey) : undefined} aria-label={t(g.labelKey)}>
              <MenuIconGlyph icon={g.icon} /><span className="menu-label">{t(g.labelKey)}</span><Chevron />
            </button>
            {!collapsed && open[g.id] && (
              <ul id={`menu-${g.id}`} className="menu-sub">
                {g.items.map((i) => (
                  <li key={i.id}><NavLink className="nav menu-link menu-subitem" to={i.to} end onClick={onNavigate}>{t(i.labelKey)}</NavLink></li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </nav>

      <div className="menu-foot">
        <SyncBadge />
        <select className="menu-label" aria-label={t('auth.language')} value={SELECTABLE_LOCALES.includes(locale as never) ? locale : 'es-MX'} onChange={(e) => setLocale(e.target.value)}>
          {SELECTABLE_LOCALES.map((l) => <option key={l} value={l}>{NAMES[l]}</option>)}
        </select>
        <button className="btn menu-label" onClick={async () => { await signOut(); onNavigate?.(); nav('/login'); }}>{t('nav.signout')}</button>
      </div>
    </aside>
  );
}
