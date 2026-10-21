import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, accessToken, fetchConfig, get, getSession, patch, setSession, type PublicConfig } from './api.js';
import { supabase } from './auth.js';
import { setQueueOwner } from './offline.js';
import { I18nProvider, type Terminology } from './i18n.js';

/** Least to most access. A person can hold several; Super Admin is a separate platform-wide flag. */
export const ROLES = ['resident', 'attendant', 'supervisor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface Me {
  roles: Role[];
  user: { id: string; email: string; name: string | null; phone: string | null; locale: string | null } | null;
  /** A short-lived signed URL for the resident's profile picture, or null. */
  avatarUrl?: string | null;
  unit: { code: string; name: string } | null;
  /** Whether the caller's unit grant is verified. FEAT-005 finalizes this; read defensively (missing => verified). */
  unitVerified?: boolean;
  superadmin: boolean;
  tenant: { slug: string; name: string; country: string; default_locale: string; locales: string[]; currency: string; plate_regions: string[]; ai_mode: 'off' | 'assist' | 'auto'; terminology: Terminology; slot_types: { code: string; label: string | Record<string, string> }[]; retention_days: number; training_export: boolean };
}
export interface SiteInfo { code: string; name: string; timezone: string; settings: { aiThreshold?: number }; zones: { code: string; name: string; labels: Record<string, string>; level: number | null }[] }
export interface Membership { slug: string; name: string; roles: Role[]; unitId: string | null; suspended: boolean }
export interface PlatformTenant { slug: string; name: string }
export interface Who { user: { email: string; name: string | null; phone: string | null; locale: string | null } | null; superadmin: boolean; memberships: Membership[] }

interface AppCtx {
  /** Deployment flags from the API: is self-service trial signup open? */
  config: PublicConfig;
  me: Me | null;
  /** The signed-in identity, even before it belongs to any organisation. */
  who: Who | null;
  sites: SiteInfo[];
  site: SiteInfo | null;
  setSiteCode: (c: string) => void;
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
  switchTenant: (slug: string) => Promise<void>;
  can: (p: 'admin' | 'override' | 'attend') => boolean;
}
const Ctx = createContext<AppCtx>(null as never);
export const useApp = () => useContext(Ctx);

/**
 * May this person edit tenant settings (the guest-pass policy)? This MUST mirror the server's `settings.edit`
 * permission, which only admins and super admins hold — supervisors deliberately do not. Gating the policy editor on
 * `can('override')` wrongly enabled it for supervisors, who then hit a guaranteed 403 on PATCH /v1/pass-policy.
 */
export const canEditPassPolicy = (me: Me | null): boolean => !!me && (me.superadmin || me.roles.includes('admin'));

/** Pick a localized label from a string or locale map: exact locale, then language, then en, then first. */
export function pickLabel(label: string | Record<string, string> | undefined, locale: string, fallback = ''): string {
  if (!label) return fallback;
  if (typeof label === 'string') return label;
  return label[locale] ?? label[locale.split('-')[0]!] ?? label.en ?? Object.values(label)[0] ?? fallback;
}

/** Where a signed-in person lands: each role gets its own home. */
export function homeFor(me: Me | null, who: Who | null): string {
  if (me) {
    const r = me.roles;
    const home = me.superadmin || r.includes('admin') || r.includes('supervisor') ? 'dashboard' : r.includes('attendant') ? 'a' : r.includes('resident') ? 'r' : 'dashboard';
    return `/t/${me.tenant.slug}/${home}`;
  }
  if (who) return who.superadmin ? '/platform' : '/onboarding';
  return '/login';
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [who, setWho] = useState<Who | null>(null);
  const [sites, setSites] = useState<SiteInfo[]>([]);
  const [siteCode, setSiteCodeState] = useState<string | null>(() => { try { return localStorage.getItem('op.site'); } catch { return null; } });
  const [loaded, setLoaded] = useState(false);
  const [config, setConfig] = useState<PublicConfig>({ trialSignup: false, auth: 'local' });

  const clear = useCallback(() => { setMe(null); setWho(null); setSites([]); }, []);

  const reload = useCallback(async () => {
    if (!(await accessToken())) { clear(); setLoaded(true); return; }
    try {
      const w = await get<Who>('/v1/auth/memberships');
      setWho(w);
      const stored = getSession().tenant;
      // A member may use any of their organisations; a platform super admin may also enter one they do not belong to.
      const slug = stored && (w.memberships.some((m) => m.slug === stored) || w.superadmin) ? stored : (w.memberships[0]?.slug ?? null);
      if (slug !== stored) setSession({ ...getSession(), tenant: slug });
      if (!slug) { setMe(null); setSites([]); setLoaded(true); return; }
      const m = await get<Me>('/v1/me');
      setMe(m);
      setQueueOwner(m.user?.id ?? '');
      // Residents see only their unit's passes; everyone else gets the site list.
      setSites(m.roles.length === 1 && m.roles[0] === 'resident' && !m.superadmin ? [] : await get<SiteInfo[]>('/v1/sites'));
    } catch (e) {
      if (e instanceof ApiError && [400, 401, 403].includes(e.status)) {
        if (e.status === 401) { setSession({ token: null, tenant: null }); clear(); }
        else { setMe(null); setSites([]); }
      }
    }
    setLoaded(true);
  }, [clear]);

  useEffect(() => { void fetchConfig().then(setConfig); void reload(); }, [reload]);

  // Supabase: react to sign-in/out (and password-recovery links) without a page reload.
  useEffect(() => {
    if (!supabase) return;
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') void reload();
      if (event === 'PASSWORD_RECOVERY') location.replace('/reset');
    });
    return () => data.subscription.unsubscribe();
  }, [reload]);

  const site = useMemo(() => sites.find((s) => s.code === siteCode) ?? sites[0] ?? null, [sites, siteCode]);
  const value: AppCtx = {
    config, me, who, sites, site, reload,
    setSiteCode: (c) => { setSiteCodeState(c); try { localStorage.setItem('op.site', c); } catch { /* ignore */ } },
    signOut: async () => {
      if (supabase) await supabase.auth.signOut();
      setSession({ token: null, tenant: null }); clear(); setQueueOwner('');
    },
    switchTenant: async (slug) => { setSession({ ...getSession(), tenant: slug }); await reload(); },
    can: (p) => !!me && (me.superadmin || me.roles.some((r) => (p === 'attend' ? r !== 'resident' : p === 'admin' ? r === 'admin' || r === 'supervisor' : r === 'admin' || r === 'supervisor'))),
  };
  if (!loaded) return null;
  return (
    <Ctx.Provider value={value}>
      <I18nProvider onLocaleChange={(l) => { if (me || who) void patch('/v1/me/profile', { locale: l }).catch(() => undefined); }} defaultLocale={me?.user?.locale ?? who?.user?.locale ?? me?.tenant.default_locale ?? navigator.language ?? 'en'} terminology={me?.tenant.terminology ?? {}}>
        {children}
      </I18nProvider>
    </Ctx.Provider>
  );
}
