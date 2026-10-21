import { IntlMessageFormat } from 'intl-messageformat';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

const files = import.meta.glob('./locales/*.json', { eager: true, import: 'default' }) as Record<string, Record<string, string>>;
export const catalogs: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries(files).map(([p, m]) => [p.replace('./locales/', '').replace('.json', ''), m]),
);

export const LOCALES = ['en', 'es-MX', 'es-ES', 'pt-BR', 'fr', 'de', 'ar'] as const;
export const NAMES: Record<string, string> = {
  en: 'English', 'es-MX': 'Español (México)', 'es-ES': 'Español (España)', 'pt-BR': 'Português (Brasil)', fr: 'Français', de: 'Deutsch', ar: 'العربية', 'en-XA': 'Pseudo (en-XA)',
};
/** Map any BCP 47 tag (es-419, pt, fr-CA, en-GB) to the closest catalog we ship. */
export function resolveLocale(tag: string | undefined | null): string {
  if (!tag) return 'en';
  if (catalogs[tag]) return tag;
  const lang = tag.split('-')[0]!.toLowerCase();
  const sameLang = LOCALES.filter((l) => l.split('-')[0] === lang);
  return sameLang[0] ?? 'en';
}

const RTL = new Set(['ar', 'he', 'fa', 'ur']);
export const isRtl = (l: string) => RTL.has(l.split('-')[0]!);

/** Tenant terminology: `{ "es-MX": { "term.slot": "{count, plural, one {lugar} other {lugares}}" } }`, `*` applies to every locale. */
export type Terminology = Record<string, Record<string, string>>;

function lookup(locale: string, key: string, terms: Terminology): string {
  return terms[locale]?.[key] ?? terms['*']?.[key] ?? catalogs[locale]?.[key] ?? catalogs[locale.split('-')[0]!]?.[key] ?? catalogs.en![key] ?? key;
}

const cache = new Map<string, IntlMessageFormat>();
export function translate(locale: string, key: string, values: Record<string, unknown> = {}, terms: Terminology = {}): string {
  const msg = lookup(locale, key, terms);
  const id = `${locale}|${msg}`;
  let f = cache.get(id);
  if (!f) { f = new IntlMessageFormat(msg, locale); cache.set(id, f); }
  try { return String(f.format(values as never)); } catch { return msg; }
}

let active = 'en';
/** The locale in use right now, for code outside React (error messages). */
export const currentLocale = () => active;

interface Ctx { locale: string; setLocale: (l: string) => void; t: (key: string, values?: Record<string, unknown>) => string; dir: 'ltr' | 'rtl' }
const I18n = createContext<Ctx>({ locale: 'en', setLocale: () => {}, t: (k) => k, dir: 'ltr' });

export function I18nProvider({ defaultLocale, terminology, onLocaleChange, children }: { defaultLocale: string; terminology: Terminology; onLocaleChange?: (l: string) => void; children: ReactNode }) {
  const [override, setOverride] = useState<string | null>(() => { try { return localStorage.getItem('op.locale'); } catch { return null; } });
  const locale = resolveLocale(override ?? defaultLocale);
  active = locale;
  const setLocale = useCallback((l: string) => { setOverride(l); try { localStorage.setItem('op.locale', l); } catch { /* ignore */ } onLocaleChange?.(l); }, [onLocaleChange]);
  const dir = isRtl(locale) ? 'rtl' : 'ltr';
  useEffect(() => { document.documentElement.lang = locale; document.documentElement.dir = dir; }, [locale, dir]);
  const value = useMemo<Ctx>(() => ({ locale, setLocale, dir, t: (k, v) => translate(locale, k, v, terminology) }), [locale, setLocale, dir, terminology]);
  return <I18n.Provider value={value}>{children}</I18n.Provider>;
}

export const useI18n = () => useContext(I18n);
export const useT = () => useContext(I18n).t;

/** Dates render in the *site's* timezone, never the device's. */
export function useFormat(timezone?: string, currency?: string) {
  const { locale } = useI18n();
  return useMemo(() => ({
    dateTime: (d: string | Date) => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: timezone }).format(new Date(d)),
    time: (d: string | Date) => new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: timezone }).format(new Date(d)),
    money: (minor: number) => new Intl.NumberFormat(locale, { style: 'currency', currency: currency ?? 'USD' }).format(minor / 100),
    number: (n: number) => new Intl.NumberFormat(locale).format(n),
    percent: (n: number) => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(n),
  }), [locale, timezone, currency]);
}
