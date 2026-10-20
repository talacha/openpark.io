import { z } from 'zod';

export const PlateClass = z.enum([
  'private', 'commercial', 'motorcycle', 'temporary', 'diplomatic', 'dealer', 'government',
]);
export type PlateClass = z.infer<typeof PlateClass>;

/** One file per region in /registry/plates, Apache-2.0. */
export const PlateRegion = z.object({
  region: z.string(),
  name: z.string(),
  charset: z.string(),
  patterns: z.array(z.object({ class: PlateClass, regex: z.string(), lines: z.number().int().min(1).default(1) })),
  /** Characters the OCR commonly mixes up, as pairs. */
  confusables: z.array(z.tuple([z.string(), z.string()])).default([]),
});
export type PlateRegion = z.infer<typeof PlateRegion>;

const SEPARATORS = /[\s\-.·_/\\•]/gu;

function foldDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
}

/** Match key: NFC/NFKC, upper-case, separators stripped, non-ASCII digits folded. */
export function normalizePlate(display: string): string {
  // NFKC folds full-width forms to ASCII; digits folded explicitly for Arabic scripts.
  return foldDigits(display.normalize('NFKC')).toUpperCase().replace(SEPARATORS, '');
}

export function displayPlate(raw: string): string {
  return raw.normalize('NFC').trim();
}

export function matchPlateClass(region: PlateRegion, norm: string): PlateClass | null {
  for (const p of region.patterns) if (new RegExp(`^(?:${p.regex})$`, 'u').test(norm)) return p.class;
  return null;
}

/** Confusable-weighted edit distance: swapping a confusable pair costs 0.25. */
export function plateDistance(a: string, b: string, confusables: [string, string][] = []): number {
  const conf = new Set(confusables.flatMap(([x, y]) => [x + y, y + x]));
  const m = a.length, n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array<number>(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const ca = a[i - 1]!, cb = b[j - 1]!;
      const sub = ca === cb ? 0 : conf.has(ca + cb) ? 0.25 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + sub);
    }
  }
  return d[m]![n]!;
}

/**
 * Correct confusable characters only where the region's pattern then validates,
 * e.g. an `O` read in a digit position of a Mexican plate becomes `0`.
 */
export function correctConfusables(region: PlateRegion, norm: string): string | null {
  if (matchPlateClass(region, norm)) return norm;
  const pairs = region.confusables.flatMap(([x, y]) => [[x, y], [y, x]] as const);
  const chars = [...norm];
  const search = (i: number): string | null => {
    if (i === chars.length) {
      const cand = chars.join('');
      return matchPlateClass(region, cand) ? cand : null;
    }
    const orig = chars[i]!;
    const hit = search(i + 1);
    if (hit) return hit;
    for (const [from, to] of pairs) {
      if (from !== orig) continue;
      chars[i] = to;
      const r = search(i + 1);
      chars[i] = orig;
      if (r) return r;
    }
    return null;
  };
  return search(0);
}
