import { describe, expect, it } from 'vitest';
import { COPY, LOCALES, href, isRtl } from '../src/i18n';

/** Every locale must carry the full structure; a missing string would render as "undefined" on the page. */
const shape = (v: unknown): unknown => (Array.isArray(v) ? v.map(shape) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v);

describe('marketing copy', () => {
  for (const l of LOCALES) {
    it(`${l}: same structure as English, no empty strings`, () => {
      expect(shape(COPY[l])).toEqual(shape(COPY.en));
      const walk = (v: unknown) => { if (typeof v === 'string') expect(v.trim()).not.toBe(''); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
      walk(COPY[l]);
    });
  }
  it('prefixes every locale but English and flags Arabic as RTL', () => {
    expect(href('en', '/pricing')).toBe('/pricing/');
    expect(href('es-MX')).toBe('/es-MX/');
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('de')).toBe(false);
  });
  it('does not state hosted prices (they are an open question in the architecture)', () => {
    for (const l of LOCALES) expect(JSON.stringify(COPY[l].pricing)).not.toMatch(/[$€]\s?\d|\d\s?(USD|MXN|EUR)/);
  });
});
