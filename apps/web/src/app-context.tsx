import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, get, getSession, setSession } from './api.js';
import { I18nProvider, type Terminology } from './i18n.js';

export interface Me {
  role: 'owner' | 'admin' | 'supervisor' | 'attendant' | 'auditor';
  user: { id: string; email: string; name: string | null; locale: string | null } | null;
  tenant: { slug: string; name: string; country: string; default_locale: string; locales: string[]; currency: string; plate_regions: string[]; ai_mode: 'off' | 'assist' | 'auto'; terminology: Terminology; slot_types: { code: string; label: string | Record<string, string> }[] };
}
export interface SiteInfo { code: string; name: string; timezone: string; settings: { aiThreshold?: number }; zones: { code: string; name: string; labels: Record<string, string>; level: number | null }[] }

interface AppCtx {
  me: Me | null;
  sites: SiteInfo[];
  site: SiteInfo | null;
  setSiteCode: (c: string) => void;
  reload: () => Promise<void>;
  signOut: () => void;
  can: (p: 'admin' | 'override' | 'attend') => boolean;
}

/** Pick a localized label from a string or locale map: exact locale, then language, then en, then first. */
export function pickLabel(label: string | Record<string, string> | undefined, locale: string, fallback = ''): string {
  if (!label) return fallback;
  if (typeof label === 'string') return label;
  return label[locale] ?? label[locale.split('-')[0]!] ?? label.en ?? Object.values(label)[0] ?? fallback;
}
const Ctx = createContext<AppCtx>(null as never);
export const useApp = () => useContext(Ctx);

const ADMIN_ROLES = new Set(['owner', 'admin', 'auditor', 'supervisor']);

export function AppProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [sites, setSites] = useState<SiteInfo[]>([]);
  const [siteCode, setSiteCodeState] = useState<string | null>(() => { try { return localStorage.getItem('op.site'); } catch { return null; } });
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!getSession().token) { setMe(null); setLoaded(true); return; }
    try {
      const [m, s] = await Promise.all([get<Me>('/v1/me'), get<SiteInfo[]>('/v1/sites')]);
      setMe(m); setSites(s);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 400)) { setSession({ token: null, tenant: null }); setMe(null); }
    }
    setLoaded(true);
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const site = useMemo(() => sites.find((s) => s.code === siteCode) ?? sites[0] ?? null, [sites, siteCode]);
  const value: AppCtx = {
    me, sites, site, reload,
    setSiteCode: (c) => { setSiteCodeState(c); try { localStorage.setItem('op.site', c); } catch { /* ignore */ } },
    signOut: () => { setSession({ token: null, tenant: null }); setMe(null); setSites([]); },
    can: (p) => !!me && (p === 'attend' ? true : p === 'admin' ? ADMIN_ROLES.has(me.role) : ['owner', 'admin', 'supervisor'].includes(me.role)),
  };
  if (!loaded) return null;
  return (
    <Ctx.Provider value={value}>
      <I18nProvider defaultLocale={me?.user?.locale ?? me?.tenant.default_locale ?? navigator.language ?? 'en'} terminology={me?.tenant.terminology ?? {}}>
        {children}
      </I18nProvider>
    </Ctx.Provider>
  );
}
