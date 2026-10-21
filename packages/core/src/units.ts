import { z } from 'zod';

/** A resident to attach to a unit. Existing accounts join directly; others are invited (or created, with local auth). */
export const UnitResident = z.object({ email: z.string().email(), name: z.string().max(100).optional() }).passthrough();

export const UnitEntry = z.object({
  code: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(100),
  /** Site code the unit's guest passes belong to; optional when the tenant has a single site. */
  site: z.string().optional(),
  residents: z.array(UnitResident).default([]),
}).passthrough();

export const UnitsDoc = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1),
  tenant: z.string(),
  exportedAt: z.string().optional(),
  units: z.array(UnitEntry),
}).passthrough().superRefine((d, ctx) => {
  const seen = new Set<string>();
  d.units.forEach((u, i) => {
    if (seen.has(u.code)) ctx.addIssue({ code: 'custom', path: ['units', i, 'code'], message: `duplicate unit code "${u.code}"` });
    seen.add(u.code);
  });
});
export type UnitsDoc = z.infer<typeof UnitsDoc>;
export type UnitEntry = z.infer<typeof UnitEntry>;

export interface LiveUnit {
  code: string;
  name: string;
  site: string | null;
  residents: { email: string }[];
  /** Guest passes reference the unit, so it cannot be removed once any exist. */
  hasPasses: boolean;
  /** Pending invitations name the unit, and would vanish with it. */
  hasInvites?: boolean;
}

export interface UnitsDiff {
  added: UnitEntry[];
  changed: { before: LiveUnit; after: UnitEntry }[];
  /** `replace` mode: units absent from the file that can be removed safely. */
  removed: LiveUnit[];
  conflicts: { unit: LiveUnit; reason: 'has_residents' | 'has_passes' | 'has_invites' }[];
  /** Resident emails in the file that are not yet attached to that unit. */
  residentsToAdd: { unit: string; email: string; name?: string }[];
  /** Site codes in the file that the caller must check exist. */
  sites: string[];
}

const norm = (e: string) => e.trim().toLowerCase();

/** Preview of what importing `incoming` would do. Residents are only ever added, never removed by an import. */
export function diffUnits(live: LiveUnit[], incoming: UnitEntry[], mode: 'merge' | 'replace'): UnitsDiff {
  const liveMap = new Map(live.map((u) => [u.code, u]));
  const inCodes = new Set(incoming.map((u) => u.code));
  const diff: UnitsDiff = { added: [], changed: [], removed: [], conflicts: [], residentsToAdd: [], sites: [...new Set(incoming.flatMap((u) => (u.site ? [u.site] : [])))] };
  for (const u of incoming) {
    const cur = liveMap.get(u.code);
    if (!cur) diff.added.push(u);
    else if (cur.name !== u.name || (u.site !== undefined && (cur.site ?? '') !== u.site)) diff.changed.push({ before: cur, after: u });
    const have = new Set((cur?.residents ?? []).map((r) => norm(r.email)));
    for (const r of u.residents) if (!have.has(norm(r.email))) diff.residentsToAdd.push({ unit: u.code, email: norm(r.email), ...(r.name ? { name: r.name } : {}) });
  }
  if (mode === 'replace') {
    for (const u of live) {
      if (inCodes.has(u.code)) continue;
      if (u.residents.length) diff.conflicts.push({ unit: u, reason: 'has_residents' });
      else if (u.hasPasses) diff.conflicts.push({ unit: u, reason: 'has_passes' });
      else if (u.hasInvites) diff.conflicts.push({ unit: u, reason: 'has_invites' });
      else diff.removed.push(u);
    }
  }
  return diff;
}
