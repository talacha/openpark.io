import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import { catalogs, isRtl, LOCALES, translate } from '../src/i18n.js';

const en = catalogs.en!;
// Argument names from the ICU AST (types 1-6 carry a name; plural/select recurse into their branches).
type Node = { type: number; value?: unknown; options?: Record<string, { value: Node[] }> };
function collect(nodes: Node[], out: Set<string> = new Set()): Set<string> {
  for (const n of nodes) {
    if (n.type >= 1 && n.type <= 6 && typeof n.value === 'string') out.add(n.value);
    if (n.options) for (const o of Object.values(n.options)) collect(o.value, out);
  }
  return out;
}
const placeholders = (m: string, l = 'en') => [...collect(new IntlMessageFormat(m, l).getAst() as unknown as Node[])].sort();

describe('locale catalogs', () => {
  for (const l of LOCALES) {
    it(`${l}: has exactly the English keys and every message parses as ICU`, () => {
      const c = catalogs[l]!;
      expect(Object.keys(c).sort()).toEqual(Object.keys(en).sort());
      for (const [k, v] of Object.entries(c)) expect(() => new IntlMessageFormat(v, l), `${l}:${k}`).not.toThrow();
    });
    it(`${l}: keeps the same placeholders as English`, () => {
      for (const [k, v] of Object.entries(catalogs[l]!)) expect(placeholders(v, l), `${l}:${k}`).toEqual(placeholders(en[k]!));
    });
  }
});

describe('translate', () => {
  it('pluralises with ICU rules, including Arabic', () => {
    expect(translate('en', 'sessions.count', { count: 0 })).toBe('No sessions');
    expect(translate('en', 'sessions.count', { count: 1 })).toBe('1 session');
    expect(translate('es-MX', 'sessions.count', { count: 3 })).toBe('3 sesiones');
    expect(translate('ar', 'sessions.count', { count: 2 })).toBe('جلستان');
  });
  it('lets tenant terminology override the base locale ("lugar" instead of "cajón")', () => {
    const terms = { 'es-MX': { 'term.slot': '{count, plural, one {lugar} other {lugares}}' } };
    expect(translate('es-MX', 'term.slot', { count: 2 })).toBe('cajones');
    expect(translate('es-MX', 'term.slot', { count: 2 }, terms)).toBe('lugares');
  });
  it('falls back to English for unknown locales and to the key for unknown keys', () => {
    expect(translate('xx', 'nav.sessions')).toBe('Sessions');
    expect(translate('en', 'no.such.key')).toBe('no.such.key');
  });
  it('flags right-to-left locales', () => {
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('en')).toBe(false);
  });
});

import { resolveLocale, surfaceLocale } from '../src/i18n.js';
describe('surfaceLocale (AC-5.4: Spanish is the default)', () => {
  it('defaults to es-MX when there is NO saved override and no app/browser preference', () => {
    expect(surfaceLocale(null, '')).toBe('es-MX');
    expect(surfaceLocale(undefined, undefined)).toBe('es-MX');
    expect(surfaceLocale(null, null)).toBe('es-MX');
  });
  it('honours an explicit preference and folds it onto the two-locale surface', () => {
    expect(surfaceLocale('en', '')).toBe('en');          // saved English stays English
    expect(surfaceLocale(null, 'en')).toBe('en');         // an English tenant/browser stays English
    expect(surfaceLocale('es-ES', '')).toBe('es-MX');     // any Spanish folds to es-MX
    expect(surfaceLocale(null, 'pt-BR')).toBe('en');      // a non-Spanish, non-English locale folds to en
    expect(surfaceLocale('es-MX', 'en')).toBe('es-MX');   // the saved override wins over the app default
  });
});

describe('resolveLocale', () => {
  it('maps browser tags to the closest shipped catalog', () => {
    expect(resolveLocale('es-419')).toBe('es-MX');
    expect(resolveLocale('es')).toBe('es-MX');
    expect(resolveLocale('pt')).toBe('pt-BR');
    expect(resolveLocale('pt-PT')).toBe('pt-BR');
    expect(resolveLocale('fr-CA')).toBe('fr');
    expect(resolveLocale('en-GB')).toBe('en');
    expect(resolveLocale('ja')).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
    expect(resolveLocale('de')).toBe('de');
  });
});
