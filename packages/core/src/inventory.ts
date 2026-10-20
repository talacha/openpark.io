import { z } from 'zod';

const Label = z.union([z.string(), z.record(z.string())]);
const SlotStatus = z.enum(['available', 'occupied', 'reserved', 'out_of_service']);

const Assignment = z.object({ mode: z.enum(['assigned', 'shared']), permit: z.string().optional() }).passthrough();

const SlotEntry = z.object({
  code: z.string().optional(),
  range: z.string().optional(),
  type: z.string(),
  status: SlotStatus.optional(),
  note: z.string().optional(),
  attributes: z.record(z.unknown()).optional(),
  assignment: Assignment.optional(),
}).passthrough().refine((s) => !!s.code !== !!s.range, { message: 'slot needs exactly one of "code" or "range"' });

export const InventoryDoc = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1),
  tenant: z.string(),
  exportedAt: z.string().optional(),
  slotTypes: z.array(z.object({ code: z.string(), label: Label }).passthrough()).default([]),
  sites: z.array(z.object({
    code: z.string(),
    name: z.string(),
    timezone: z.string(),
    address: z.string().optional(),
    zones: z.array(z.object({
      code: z.string(),
      name: Label,
      level: z.number().int().optional(),
      slots: z.array(SlotEntry),
    }).passthrough()),
  }).passthrough()),
}).passthrough();
export type InventoryDoc = z.infer<typeof InventoryDoc>;

export interface FlatSlot {
  site: string;
  zone: string;
  code: string;
  type: string;
  status: z.infer<typeof SlotStatus>;
  attributes: Record<string, unknown>;
  assignment: z.infer<typeof Assignment> | null;
  note?: string;
}

const MAX_RANGE = 10_000;

/** `B2-001..B2-080` -> B2-001 ... B2-080, keeping zero-padding width. */
export function expandRange(range: string): string[] {
  const [a, b, ...extra] = range.split('..');
  if (!a || !b || extra.length) throw new Error(`invalid range "${range}"`);
  const pa = /^(.*?)(\d+)$/.exec(a), pb = /^(.*?)(\d+)$/.exec(b);
  if (!pa || !pb || pa[1] !== pb[1]) throw new Error(`range "${range}" must share a prefix and end in digits`);
  const start = Number(pa[2]), end = Number(pb[2]);
  if (end < start) throw new Error(`range "${range}" ends before it starts`);
  if (end - start >= MAX_RANGE) throw new Error(`range "${range}" exceeds ${MAX_RANGE} slots`);
  const width = pa[2]!.length;
  return Array.from({ length: end - start + 1 }, (_, i) => pa[1]! + String(start + i).padStart(width, '0'));
}

/** Expand ranges; a later entry with the same code overrides the earlier one. */
export function flattenInventory(doc: InventoryDoc): FlatSlot[] {
  const out = new Map<string, FlatSlot>();
  for (const site of doc.sites) {
    for (const zone of site.zones) {
      for (const s of zone.slots) {
        const codes = s.range ? expandRange(s.range) : [s.code!];
        for (const code of codes) {
          out.set(`${site.code}/${code}`, {
            site: site.code, zone: zone.code, code, type: s.type,
            status: s.status ?? 'available',
            attributes: s.attributes ?? {},
            assignment: s.assignment ?? null,
            ...(s.note ? { note: s.note } : {}),
          });
        }
      }
    }
  }
  return [...out.values()];
}

export interface LiveSlot extends FlatSlot {}
export interface InventoryDiff {
  added: FlatSlot[];
  changed: { before: LiveSlot; after: FlatSlot }[];
  retired: LiveSlot[];
  conflicts: { slot: LiveSlot; reason: 'occupied' | 'permit_assigned' }[];
}

/** `occupied` is runtime state owned by sessions, so it never differs from an imported `available`. */
const stableStatus = (s: FlatSlot) => (s.status === 'occupied' ? 'available' : s.status);

const same = (a: FlatSlot, b: FlatSlot) =>
  a.zone === b.zone && a.type === b.type && stableStatus(a) === stableStatus(b) &&
  JSON.stringify(a.attributes) === JSON.stringify(b.attributes) &&
  JSON.stringify(a.assignment) === JSON.stringify(b.assignment);

export function diffInventory(live: LiveSlot[], incoming: FlatSlot[], mode: 'merge' | 'replace'): InventoryDiff {
  const key = (s: FlatSlot) => `${s.site}/${s.code}`;
  const liveMap = new Map(live.map((s) => [key(s), s]));
  const inKeys = new Set(incoming.map(key));
  const diff: InventoryDiff = { added: [], changed: [], retired: [], conflicts: [] };
  for (const s of incoming) {
    const cur = liveMap.get(key(s));
    if (!cur) diff.added.push(s);
    else if (!same(cur, s)) diff.changed.push({ before: cur, after: s });
  }
  if (mode === 'replace') {
    for (const s of live) {
      if (inKeys.has(key(s))) continue;
      if (s.status === 'occupied') diff.conflicts.push({ slot: s, reason: 'occupied' });
      else if (s.assignment?.permit) diff.conflicts.push({ slot: s, reason: 'permit_assigned' });
      else diff.retired.push(s);
    }
  }
  return diff;
}

/** Collapse consecutive same-type, same-zone slots back into ranges for compact export. */
export function exportSlots(slots: FlatSlot[]): { code?: string; range?: string; type: string; status?: string; attributes?: Record<string, unknown>; assignment?: unknown; note?: string }[] {
  return slots.map((s) => ({
    code: s.code, type: s.type,
    ...(s.status !== 'available' ? { status: s.status } : {}),
    ...(Object.keys(s.attributes).length ? { attributes: s.attributes } : {}),
    ...(s.assignment ? { assignment: s.assignment } : {}),
    ...(s.note ? { note: s.note } : {}),
  }));
}
