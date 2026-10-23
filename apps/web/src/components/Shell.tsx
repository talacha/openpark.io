import { useEffect, useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useApp } from '../app-context.js';
import { useT } from '../i18n.js';
import { AppMenu } from './AppMenu.js';
import { Invitations } from './Invitations.js';
import { SyncBadge } from './SyncBadge.js';

const COLLAPSED_KEY = 'op.menu.collapsed';
const readCollapsed = (): boolean => { try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; } };

/** One shell for every role and every screen: the shared menu plus the page. Wide screens get a sidebar, phones a drawer. */
export function AppShell() {
  const { who, me } = useApp();
  const t = useT();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  // Wide-screen collapse (icons only). Lazy-init from localStorage, falling back to expanded in private mode.
  const [collapsed, setCollapsed] = useState(readCollapsed);
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [open]);
  const toggleCollapsed = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem(COLLAPSED_KEY, n ? '1' : '0'); } catch { /* private mode */ } return n; });
  if (!who) return <Navigate to="/login" replace />;

  return (
    <div className="shell" data-open={open} data-collapsed={collapsed}>
      <AppMenu onNavigate={() => setOpen(false)} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
      {open && <button type="button" className="scrim" aria-label={t('nav.closeMenu')} onClick={() => setOpen(false)} />}
      <div className="content">
        <header className="topbar">
          <button type="button" className="btn" aria-label={open ? t('nav.closeMenu') : t('nav.menu')} aria-expanded={open} aria-controls="app-menu" onClick={() => setOpen(!open)}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
          <strong className="grow">{me?.tenant.name ?? t('app.name')}</strong>
          <SyncBadge />
        </header>
        <main className="main"><Invitations /><Outlet /></main>
      </div>
    </div>
  );
}

/** Operator view: the pages plus a bottom tab bar for one-handed use on phones. */
export function AttendantLayout() {
  const { me } = useApp();
  const t = useT();
  const base = `/t/${me!.tenant.slug}/a`;
  return (
    <>
      <Outlet />
      <nav className="tabbar" aria-label={t('nav.operatorView')}>
        <NavLink end to={base}>{t('att.home')}</NavLink>
        <NavLink to={`${base}/checkin`}>{t('att.checkin')}</NavLink>
        <NavLink to={`${base}/checkout`}>{t('att.checkout')}</NavLink>
      </nav>
    </>
  );
}
