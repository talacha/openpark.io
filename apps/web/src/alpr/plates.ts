/** Plate-format check against the same registry the server uses (registry/plates/*.json), bundled so it works offline. */
interface Region { region: string; patterns: { class: string; regex: string }[]; confusables?: [string, string][] }

const files = import.meta.glob('../../../../registry/plates/*.json', { eager: true, import: 'default' }) as Record<string, Region>;
const REGISTRY: Region[] = Object.values(files);

export const normalizePlate = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Does `text` match a known format for any of the tenant's regions (all regions when none are configured)? */
export function matchesRegistry(text: string, regions: string[] = []): boolean {
  const norm = normalizePlate(text);
  if (norm.length < 4) return false;
  const pool = regions.length ? REGISTRY.filter((r) => regions.includes(r.region)) : REGISTRY;
  return (pool.length ? pool : REGISTRY).some((r) => r.patterns.some((p) => new RegExp(`^(?:${p.regex})$`).test(norm)));
}

/**
 * Turns a stream of per-frame reads into one decision: the same format-valid plate seen in `need` of the last `window` frames.
 * Single noisy frames never fire, which is what makes unattended auto-submit safe enough.
 */
export class PlateStabilizer {
  private seen: { text: string; confidence: number }[][] = [];
  constructor(private regions: string[] = [], private need = 2, private window = 5, private minConfidence = 0.6) {}

  push(reads: { text: string; confidence: number }[]): { text: string; confidence: number; votes: number } | null {
    this.seen.push(reads.filter((r) => r.confidence >= this.minConfidence && matchesRegistry(r.text, this.regions)).map((r) => ({ text: normalizePlate(r.text), confidence: r.confidence })));
    if (this.seen.length > this.window) this.seen.shift();
    const tally = new Map<string, { votes: number; sum: number }>();
    for (const frame of this.seen) for (const r of new Map(frame.map((x) => [x.text, x])).values()) {
      const t = tally.get(r.text) ?? { votes: 0, sum: 0 }; t.votes++; t.sum += r.confidence; tally.set(r.text, t);
    }
    let best: { text: string; confidence: number; votes: number } | null = null;
    for (const [text, t] of tally) if (t.votes >= this.need && (!best || t.votes > best.votes || (t.votes === best.votes && t.sum / t.votes > best.confidence))) best = { text, confidence: t.sum / t.votes, votes: t.votes };
    return best;
  }
  reset() { this.seen = []; }
}
