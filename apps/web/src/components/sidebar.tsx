import * as React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useApp } from '../app-context.js';
import { useT } from '../i18n.js';
import { buildMenu, type MenuGroup } from '../menu.js';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from './ui/sidebar.js';
import { Home, BarChart3, Car, Settings, User, Plus, LogOut, Globe, LayoutDashboard, List } from 'lucide-react';

const ICONS: Record<string, React.ElementType> = {
  resident: Home,
  platform: BarChart3,
  operator: Car,
  admin: Settings,
  profile: User,
  newpass: Plus,
};

export function AppSidebar() {
  const t = useT();
  const { me, who, signOut, sites, site, setSiteCode, switchTenant } = useApp();
  const { pathname } = useLocation();
  const { state, open, setOpen, openMobile, setOpenMobile, isMobile, toggleSidebar } = useSidebar()!;

  if (!me) return null;

  const groups = buildMenu({ slug: me.tenant.slug, roles: me.roles, superadmin: !!who?.superadmin });

  const active = (to: string) => pathname === to || pathname.startsWith(`${to}/`);

  const iconFor = (key: string | undefined) => {
    const Comp = ICONS[key ?? ''];
    return Comp ? <Comp className="size-4 shrink-0" /> : null;
  };

  const isMobileView = isMobile || window.innerWidth < 821;

  return (
    <SidebarProvider defaultOpen={true}>
      {isMobileView ? (
        <Sidebar side="left" collapsible="none">
          <SidebarContent className="p-0">
            <AppSidebarContent />
          </SidebarContent>
        </Sidebar>
      ) : (
        <>
          <Sidebar side="left" collapsible="icon">
            <AppSidebarContent />
          </Sidebar>
          <SidebarRail />
        </>
      )}
    </SidebarProvider>
  );

  function AppSidebarContent() {
    return (
      <>
        <SidebarHeader className="flex flex-col gap-1 p-2">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-6 h-6 rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
              <Home className="size-4" />
            </div>
            <span className="text-sidebar-foreground font-semibold text-sm">{t('app.name')}</span>
          </div>
        </SidebarHeader>

        <SidebarSeparator />

        <SidebarContent className="flex-1 overflow-y-auto no-scrollbar">
          {groups.map((g) => {
            const groupActive = active(g.to);
            const [groupOpen, setGroupOpen] = React.useState(groupActive);

            React.useEffect(() => {
              if (groupActive) setGroupOpen(true);
            }, [groupActive]);

            return (
              <SidebarGroup key={g.id} className="group-data-[collapsible=icon]:hidden">
                <SidebarGroupLabel render={
                  <button
                    onClick={() => setGroupOpen((o) => !o)}
                    className="w-full"
                    aria-expanded={groupOpen}
                    aria-label={t(g.labelKey)}
                  >
                    {iconFor(g.icon)}
                    <span className="text-sidebar-foreground">{t(g.labelKey)}</span>
                  </button>
                } />
                {groupOpen && (
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {g.items.map((i) => (
                        <SidebarMenuItem key={i.id}>
                          <SidebarMenuButton render={
                            <NavLink
                              to={i.to}
                              className={({ isActive }) =>
                                `flex items-center gap-2 rounded-md p-2 text-sm ${
                                  isActive
                                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                                    : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                                }`
                              }
                            >
                              {iconFor(i.icon)}
                              <span className="text-sidebar-foreground">{t(i.labelKey)}</span>
                            </NavLink>
                          } isActive={active(i.to)} />
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                )}
              </SidebarGroup>
            );
          })}
        </SidebarContent>

        <SidebarSeparator />

        <SidebarFooter>
          {me && (who?.superadmin || (who?.memberships.length ?? 0) > 1) && (
            <div className="flex items-center gap-2 p-2">
              <Globe className="size-4 shrink-0" />
              <select
                className="bg-transparent text-xs text-sidebar-foreground border-none focus:ring-0"
                value={me.tenant.slug}
                onChange={async (e) => {
                  await switchTenant(e.target.value);
                  window.location.href = `/t/${e.target.value}`;
                }}
              >
                {(who?.superadmin && who?.memberships ? who.memberships : [{ slug: me.tenant.slug, name: me.tenant.name }]).map((m) => (
                  <option key={m.slug} value={m.slug}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {sites.length > 1 && (
            <div className="flex items-center gap-2 p-2">
              <LayoutDashboard className="size-4 shrink-0" />
              <select
                className="bg-transparent text-xs text-sidebar-foreground border-none focus:ring-0"
                value={site?.code}
                onChange={(e) => setSiteCode(e.target.value)}
              >
                {sites.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <SidebarSeparator />

          <button
            onClick={async () => { await signOut(); window.location.href = '/login'; }}
            className="w-full flex items-center gap-2 rounded-md p-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
          >
            <LogOut className="size-4 shrink-0" />
            <span className="text-sidebar-foreground">{t('nav.signout')}</span>
          </button>
        </SidebarFooter>
      </>
    );
  }
}
