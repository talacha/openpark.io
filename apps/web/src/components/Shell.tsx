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

function ShellContent({ collapsed }: { collapsed: boolean }) {
  const { me } = useApp();
  const t = useT();
  const { pathname } = useLocation();
  const { open, openMobile, isMobile, setOpenMobile } = useSidebar();

  useEffect(() => { setOpenMobile(false); }, [pathname, setOpenMobile]);

  return (
    <>
      <AppMenu collapsed={collapsed} onNavigate={() => setOpenMobile(false)} />
      <SidebarInset className="content">
        <header className="topbar">
          <SidebarTrigger
            className="-ms-1 size-11 md:size-7"
            aria-label={isMobile ? (openMobile ? t('nav.closeMenu') : t('nav.menu')) : (open ? t('nav.collapse') : t('nav.expand'))}
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
    >
      <ShellContent collapsed={collapsed} />
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
