import { describe, expect, it } from 'vitest';
import { InventoryDoc, diffInventory, expandRange, flattenInventory } from '../src/index.js';

const doc = InventoryDoc.parse({
  schemaVersion: 1, tenant: 'demo-plaza',
  sites: [{ code: 'TD-01', name: 'Torre Demo', timezone: 'America/Mexico_City', zones: [{
    code: 'B2', name: 'Basement 2', level: -2, slots: [
      { range: 'B2-001..B2-080', type: 'standard' },
      { code: 'B2-081', type: 'ev', attributes: { chargerKw: 11 } },
      { code: 'B2-003', type: 'standard', status: 'out_of_service', note: 'Column repair' },
      { range: 'B2-M01..B2-M12', type: 'moto' },
    ] }] }],
});

describe('expandRange', () => {
  it('keeps zero padding', () => expect(expandRange('B2-001..B2-003')).toEqual(['B2-001', 'B2-002', 'B2-003']));
  it('handles letter infixes', () => expect(expandRange('B2-M01..B2-M03')).toEqual(['B2-M01', 'B2-M02', 'B2-M03']));
  it('rejects mismatched prefixes and reversed ranges', () => {
    expect(() => expandRange('A-1..B-5')).toThrow();
    expect(() => expandRange('A-5..A-1')).toThrow();
  });
});

describe('flattenInventory', () => {
  const slots = flattenInventory(doc);
  it('expands ranges (80 + 1 + 12 slots)', () => expect(slots).toHaveLength(93));
  it('lets a later entry override a range member', () => {
    expect(slots.find((s) => s.code === 'B2-003')?.status).toBe('out_of_service');
  });
});

describe('diffInventory', () => {
  const incoming = flattenInventory(doc);
  it('is empty when an export is re-imported unchanged', () => {
    const d = diffInventory(incoming, incoming, 'replace');
    expect(d).toEqual({ added: [], changed: [], retired: [], conflicts: [] });
  });
  it('merge leaves absent slots alone', () => {
    const live = [...incoming, { ...incoming[0]!, code: 'ZZ-1' }];
    expect(diffInventory(live, incoming, 'merge').retired).toHaveLength(0);
  });
  it('replace retires absent slots but blocks on occupied or assigned ones', () => {
    const base = incoming[0]!;
    const live = [
      ...incoming,
      { ...base, code: 'X1' },
      { ...base, code: 'X2', status: 'occupied' as const },
      { ...base, code: 'X3', assignment: { mode: 'assigned' as const, permit: 'P1' } },
    ];
    const d = diffInventory(live, incoming, 'replace');
    expect(d.retired.map((s) => s.code)).toEqual(['X1']);
    expect(d.conflicts.map((c) => c.reason)).toEqual(['occupied', 'permit_assigned']);
  });
});
