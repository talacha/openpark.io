import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { CarFront, ChartNoAxesColumn, ChevronRight, Circle, House, Settings } from 'lucide-react';
import { useApp, type PlatformTenant } from '../app-context.js';
import { NAMES, SELECTABLE_LOCALES, useI18n, useT } from '../i18n.js';
import { buildMenu, type MenuGroup, type MenuIcon } from '../menu.js';
import { useApi } from './hooks.js';
import { SyncBadge } from './SyncBadge.js';
import { Button } from './ui/button.js';
import { Collapsible, CollapsibleContent } from './ui/collapsible.js';
import { NativeSelect } from './ui/native-select.js';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from './ui/sidebar.js';

const KEY = 'op.menu.open';
const readOpen = (): Record<string, boolean> => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, boolean>; } catch { return {}; }
};

const icons = {
  resident: House,
  platform: ChartNoAxesColumn,
  operator: CarFront,
  admin: Settings,
};

function MenuIconGlyph({ icon }: { icon?: MenuIcon }) {
  const Glyph = icon ? icons[icon] : Circle;
  return <Glyph className="menu-icon" aria-hidden="true" />;
}

export function AppMenu({ onNavigate, collapsed: desktopPreference = false }: {
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const t = useT();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const { me, who, sites, site, setSiteCode, signOut, switchTenant } = useApp();
  const { dir, locale, setLocale } = useI18n();
  const { isMobile, setOpen: setSidebarOpen } = useSidebar();
  const collapsed = desktopPreference && !isMobile;
  const groups = buildMenu({ slug: me?.tenant.slug ?? null, roles: me?.roles ?? [], superadmin: !!who?.superadmin });
  const allTenants = useApi<PlatformTenant[]>(who?.superadmin ? '/v1/platform/tenants' : null);
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen);
  const side = dir === 'rtl' ? 'right' : 'left';

  // Destinations may carry a query or hash (e.g. /r#new); active state is decided by the path alone.
  const pathOf = (to: string) => to.split(/[?#]/)[0] ?? to;
  const isPath = (to: string) => {
    const path = pathOf(to);
    return pathname === path || pathname.startsWith(`${path}/`);
  };
  const isExactPath = (to: string) => pathname === pathOf(to);
  const active = (group: MenuGroup) => group.items.some((item) => isPath(item.to));

  useEffect(() => {
    const here = groups.find(active);
    if (here && !open[here.id]) setOpen((current) => ({ ...current, [here.id]: true }));
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: string) => setOpen((current) => {
    const next = { ...current, [id]: !current[id] };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* Storage can be unavailable in private mode. */ }
    return next;
  });

  const onHead = (id: string) => {
    if (collapsed) {
      setSidebarOpen(true);
      setOpen((current) => ({ ...current, [id]: true }));
      return;
    }
    toggle(id);
  };

  return (
    <Sidebar id="app-menu" aria-label={t('nav.menu')} className="side menu" collapsible="icon" side={side}>
      <SidebarHeader className="gap-2 p-2">
        <div className="brand">
          <img src="/icon.svg" alt="" width="32" height="32" />
          <span className="menu-label">{t('app.name')}</span>
        </div>
        {me && <div className="menu-org menu-label">{me.tenant.name}</div>}
        {me && (who?.superadmin || (who?.memberships.length ?? 0) > 1) && (
          <NativeSelect
            className="menu-label w-full group-data-[collapsible=icon]:hidden"
            aria-label={who?.superadmin ? t('nav.property') : t('nav.tenant')}
            value={me.tenant.slug}
            onChange={async (event) => { await switchTenant(event.target.value); onNavigate?.(); nav('/'); }}
          >
            {(who?.superadmin && allTenants.data ? allTenants.data : who!.memberships).map((membership) => (
              <option key={membership.slug} value={membership.slug}>{membership.name}</option>
            ))}
          </NativeSelect>
        )}
        {sites.length > 1 && (
          <NativeSelect
            className="menu-label w-full group-data-[collapsible=icon]:hidden"
            aria-label={t('common.site')}
            value={site?.code}
            onChange={(event) => setSiteCode(event.target.value)}
          >
            {sites.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
          </NativeSelect>
        )}
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="menu-nav p-2">
          <SidebarGroupContent>
            <SidebarMenu>
              {groups.map((group) => group.items.length === 0 ? (
                <SidebarMenuItem key={group.id}>
                  <SidebarMenuButton
                    render={<NavLink to={group.to} onClick={onNavigate} />}
                    className="nav menu-link menu-top"
                    isActive={isPath(group.to)}
                    tooltip={t(group.labelKey)}
                    aria-label={t(group.labelKey)}
                    title={collapsed ? t(group.labelKey) : undefined}
                  >
                    <MenuIconGlyph icon={group.icon} />
                    <span className="menu-label">{t(group.labelKey)}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : (
                <Collapsible key={group.id} open={!collapsed && !!open[group.id]} className="menu-group" data-group={group.id}>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      className="menu-head"
                      data-active={active(group) || undefined}
                      aria-expanded={collapsed ? false : !!open[group.id]}
                      aria-controls={`menu-${group.id}`}
                      aria-label={t(group.labelKey)}
                      title={collapsed ? t(group.labelKey) : undefined}
                      tooltip={t(group.labelKey)}
                      onClick={() => onHead(group.id)}
                    >
                      <MenuIconGlyph icon={group.icon} />
                      <span className="menu-label">{t(group.labelKey)}</span>
                      <ChevronRight className="menu-chevron ms-auto" aria-hidden="true" />
                    </SidebarMenuButton>
                    <CollapsibleContent id={`menu-${group.id}`}>
                      <SidebarMenuSub className="menu-sub">
                        {group.items.map((item) => (
                          <SidebarMenuSubItem key={item.id}>
                            <SidebarMenuSubButton
                              render={<NavLink to={item.to} end onClick={onNavigate} />}
                              className="nav menu-link menu-subitem"
                              isActive={isExactPath(item.to)}
                            >
                              <span>{t(item.labelKey)}</span>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))}
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </SidebarMenuItem>
                </Collapsible>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="menu-foot">
        <SyncBadge />
        <NativeSelect
          className="menu-label w-full group-data-[collapsible=icon]:hidden"
          aria-label={t('auth.language')}
          value={SELECTABLE_LOCALES.includes(locale as never) ? locale : 'es-MX'}
          onChange={(event) => setLocale(event.target.value)}
        >
          {SELECTABLE_LOCALES.map((item) => <option key={item} value={item}>{NAMES[item]}</option>)}
        </NativeSelect>
        <Button
          variant="outline"
          className="menu-label group-data-[collapsible=icon]:hidden"
          onClick={async () => { await signOut(); onNavigate?.(); nav('/login'); }}
        >
          {t('nav.signout')}
        </Button>
      </SidebarFooter>
      <SidebarRail title={collapsed ? t('nav.expand') : t('nav.collapse')} aria-label={collapsed ? t('nav.expand') : t('nav.collapse')} />
    </Sidebar>
  );
}
