import { useEffect, useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useApp } from '../app-context.js';
import { useT } from '../i18n.js';
import { AppMenu } from './AppMenu.js';
import { Invitations } from './Invitations.js';
import { SyncBadge } from './SyncBadge.js';
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from './ui/sidebar.js';

const COLLAPSED_KEY = 'op.menu.collapsed';
const readCollapsed = (): boolean => {
  try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
};

function ShellContent({ collapsed, onToggleCollapsed }: { collapsed: boolean; onToggleCollapsed: () => void }) {
  const { me } = useApp();
  const t = useT();
  const { pathname } = useLocation();
  const { open, openMobile, isMobile, setOpenMobile } = useSidebar();

  useEffect(() => { setOpenMobile(false); }, [pathname, setOpenMobile]);

  return (
    <>
      <AppMenu collapsed={collapsed} onToggleCollapsed={onToggleCollapsed} onNavigate={() => setOpenMobile(false)} />
      <SidebarInset className="content">
        <header className="topbar">
          <SidebarTrigger
            aria-label={openMobile ? t('nav.closeMenu') : t('nav.menu')}
            aria-expanded={isMobile ? openMobile : open}
            aria-controls="app-menu"
          />
          <strong className="grow">{me?.tenant.name ?? t('app.name')}</strong>
          <SyncBadge />
        </header>
        <div className="main"><Invitations /><Outlet /></div>
      </SidebarInset>
    </>
  );
}

export function AppShell() {
  const { who } = useApp();
  const [collapsed, setCollapsed] = useState(readCollapsed);

  if (!who) return <Navigate to="/login" replace />;

  const onOpenChange = (open: boolean) => {
    setCollapsed(!open);
    try { localStorage.setItem(COLLAPSED_KEY, open ? '0' : '1'); } catch { /* Storage can be unavailable in private mode. */ }
  };

  return (
    <SidebarProvider
      className="shell"
      data-collapsed={collapsed}
      open={!collapsed}
      onOpenChange={onOpenChange}
      style={{ '--sidebar-width': '252px', '--sidebar-width-icon': '64px' } as React.CSSProperties}
    >
      <ShellContent collapsed={collapsed} onToggleCollapsed={() => onOpenChange(collapsed)} />
    </SidebarProvider>
  );
}

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
