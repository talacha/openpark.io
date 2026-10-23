import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { CarFront, ChartNoAxesColumn, ChevronRight, Circle, House, Plus, Settings, UserRound } from 'lucide-react';
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
  profile: UserRound,
  newpass: Plus,
};

function MenuIconGlyph({ icon }: { icon?: MenuIcon }) {
  const Glyph = icon ? icons[icon] : Circle;
  return <Glyph className="menu-icon" aria-hidden="true" />;
}

export function AppMenu({ onNavigate, collapsed = false, onToggleCollapsed }: {
  onNavigate?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const t = useT();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const { me, who, sites, site, setSiteCode, signOut, switchTenant } = useApp();
  const { locale, setLocale } = useI18n();
  const groups = buildMenu({ slug: me?.tenant.slug ?? null, roles: me?.roles ?? [], superadmin: !!who?.superadmin });
  const allTenants = useApi<PlatformTenant[]>(who?.superadmin ? '/v1/platform/tenants' : null);
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen);
  const side = document.documentElement.dir === 'rtl' ? 'right' : 'left';

  const active = (group: MenuGroup) => group.items.some((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));

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
      onToggleCollapsed?.();
      setOpen((current) => ({ ...current, [id]: true }));
      return;
    }
    toggle(id);
  };

  return (
    <Sidebar id="app-menu" aria-label={t('nav.menu')} className="side menu" collapsible="icon" side={side}>
      <SidebarHeader className="gap-2 p-3">
        <div className="brand">
          <img src="/icon.svg" alt="" width="24" height="24" />
          <span className="menu-label">{t('app.name')}</span>
          {onToggleCollapsed && (
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="menu-collapse"
              aria-expanded={!collapsed}
              aria-controls="app-menu"
              aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
              title={collapsed ? t('nav.expand') : t('nav.collapse')}
              onClick={onToggleCollapsed}
            >
              <ChevronRight className={collapsed ? '' : 'rotate-180 rtl:rotate-0'} aria-hidden="true" />
            </Button>
          )}
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
                    isActive={pathname === group.to || pathname.startsWith(`${group.to}/`)}
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
                              isActive={pathname === item.to}
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
