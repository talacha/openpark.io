import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useApp, type PlatformTenant } from '../app-context.js';
import { useApi } from './hooks.js';
import { LOCALES, NAMES, useI18n, useT } from '../i18n.js';
import { buildMenu, type MenuGroup } from '../menu.js';
import { SyncBadge } from './SyncBadge.js';

const KEY = 'op.menu.open';
const readOpen = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, boolean>; } catch { return {}; } };

function Chevron() {
  return <svg className="chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>;
}

/**
 * The single navigation menu: the same component and structure on every screen and device (sidebar on wide screens,
 * a drawer on phones). What it contains depends only on the person's role (see menu.ts).
 */
export function AppMenu({ onNavigate }: { onNavigate?: () => void }) {
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

  return (
    <aside className="side menu" id="app-menu" aria-label={t('nav.menu')}>
      <div className="brand"><img src="/icon.svg" alt="" width="24" height="24" />{t('app.name')}</div>
      {me && <div className="menu-org">{me.tenant.name}</div>}
      {me && (who?.superadmin || (who?.memberships.length ?? 0) > 1) && (
        <select aria-label={who?.superadmin ? t('nav.property') : t('nav.tenant')} value={me.tenant.slug} onChange={async (e) => { await switchTenant(e.target.value); onNavigate?.(); nav('/'); }}>
          {(who?.superadmin && allTenants.data ? allTenants.data : who!.memberships).map((m) => <option key={m.slug} value={m.slug}>{m.name}</option>)}
        </select>
      )}
      {sites.length > 1 && (
        <select aria-label={t('common.site')} value={site?.code} onChange={(e) => setSiteCode(e.target.value)}>
          {sites.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </select>
      )}

      <nav className="menu-nav" aria-label={t('nav.menu')}>
        {groups.map((g) => g.items.length === 0 ? (
          <NavLink key={g.id} className="nav menu-link menu-top" to={g.to} onClick={onNavigate}>{t(g.labelKey)}</NavLink>
        ) : (
          <div key={g.id} className="menu-group" data-group={g.id}>
            <button type="button" className="menu-head" aria-expanded={!!open[g.id]} aria-controls={`menu-${g.id}`} data-active={active(g)} onClick={() => toggle(g.id)}>
              <span>{t(g.labelKey)}</span><Chevron />
            </button>
            {open[g.id] && (
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
        <select aria-label={t('auth.language')} value={locale} onChange={(e) => setLocale(e.target.value)}>
          {[...LOCALES, 'en-XA' as const].map((l) => <option key={l} value={l}>{NAMES[l]}</option>)}
        </select>
        <button className="btn" onClick={async () => { await signOut(); onNavigate?.(); nav('/login'); }}>{t('nav.signout')}</button>
      </div>
    </aside>
  );
}
