import { NavLink, Navigate, Outlet } from 'react-router-dom';
import { useApp } from '../app-context.js';
import { useT } from '../i18n.js';
import { AppSidebar } from './sidebar.js';
import { Invitations } from './Invitations.js';
import { SyncBadge } from './SyncBadge.js';
import { SidebarProvider, SidebarTrigger, SidebarRail } from './ui/sidebar.js';

/** One shell for every screen: shadcn/ui sidebar plus the page.
 *  Wide screens get a collapsible sidebar; phones get a drawer. */
export function AppShell() {
  const { who, me } = useApp();
  const t = useT();
  if (!who) return <Navigate to="/login" replace />;

  return (
    <SidebarProvider defaultOpen={true}>
      <div className="relative min-h-svh">
        <AppSidebar />
        <SidebarRail />
        <div className="content md\:pl-sidebar">
          <header className="topbar">
            <SidebarTrigger />
            <strong className="grow">{me?.tenant.name ?? t('app.name')}</strong>
            <SyncBadge />
          </header>
          <main className="main"><Invitations /><Outlet /></main>
        </div>
      </div>
    </SidebarProvider>
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
