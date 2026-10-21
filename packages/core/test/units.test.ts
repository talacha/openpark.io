import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { UnitsDoc, diffUnits, type LiveUnit } from '../src/index.js';

const schema = JSON.parse(readFileSync(new URL('../../../schemas/units/v1.json', import.meta.url), 'utf8'));
const validate = addFormats(new (Ajv2020 as unknown as typeof Ajv2020.default)({ allErrors: true })).compile(schema);

const live: LiveUnit[] = [
  { code: 'A-101', name: 'Apartment A-101', site: 'TD-01', residents: [{ email: 'rosa@example.com' }], hasPasses: true },
  { code: 'A-102', name: 'Apartment A-102', site: null, residents: [], hasPasses: false },
  { code: 'A-103', name: 'Apartment A-103', site: null, residents: [], hasPasses: true },
];
const doc = (units: unknown[]) => UnitsDoc.parse({ schemaVersion: 1, tenant: 'demo', units });

describe('UnitsDoc and its JSON Schema', () => {
  const sample = { schemaVersion: 1, tenant: 'demo', exportedAt: '2026-10-20T14:00:00Z', units: [{ code: 'A-101', name: 'A 101', site: 'TD-01', residents: [{ email: 'rosa@example.com', name: 'Rosa' }] }, { code: 'A-102', name: 'A 102' }], 'x-note': 1 };
  it('agree on a valid document, including x- extensions', () => {
    expect(validate(sample), JSON.stringify(validate.errors)).toBe(true);
    expect(UnitsDoc.parse(sample).units[1]!.residents).toEqual([]);
  });
  it('reject the same mistakes', () => {
    const bad = [
      { ...sample, schemaVersion: 2 },
      { ...sample, units: [{ name: 'no code' }] },
      { ...sample, units: [{ code: 'X', name: 'X', residents: [{ email: 'not-an-email' }] }] },
    ];
    for (const b of bad) { expect(validate(b)).toBe(false); expect(UnitsDoc.safeParse(b).success).toBe(false); }
  });
  it('rejects duplicate codes, which the schema alone cannot express', () => {
    const r = UnitsDoc.safeParse({ ...sample, units: [{ code: 'A', name: 'one' }, { code: 'A', name: 'two' }] });
    expect(r.success).toBe(false);
  });
});

describe('diffUnits', () => {
  it('is empty when an export is re-imported unchanged', () => {
    const incoming = doc(live.map((u) => ({ code: u.code, name: u.name, ...(u.site ? { site: u.site } : {}), residents: u.residents }))).units;
    expect(diffUnits(live, incoming, 'replace')).toMatchObject({ added: [], changed: [], removed: [], conflicts: [], residentsToAdd: [] });
  });
  it('finds new units, renames, site changes and new residents (case-insensitively)', () => {
    const d = diffUnits(live, doc([
      { code: 'A-101', name: 'Renamed', site: 'TD-01', residents: [{ email: 'ROSA@example.com' }, { email: 'luis@example.com', name: 'Luis' }] },
      { code: 'B-201', name: 'New unit', site: 'TD-02' },
    ]).units, 'merge');
    expect(d.added.map((u) => u.code)).toEqual(['B-201']);
    expect(d.changed.map((c) => c.after.code)).toEqual(['A-101']);
    expect(d.residentsToAdd).toEqual([{ unit: 'A-101', email: 'luis@example.com', name: 'Luis' }]);
    expect(d.sites.sort()).toEqual(['TD-01', 'TD-02']);
    expect(d.removed).toEqual([]);
  });
  it('replace removes only units with no residents and no passes, and flags the rest as conflicts', () => {
    const d = diffUnits(live, doc([]).units, 'replace');
    expect(d.removed.map((u) => u.code)).toEqual(['A-102']);
    expect(d.conflicts).toEqual([{ unit: live[0], reason: 'has_residents' }, { unit: live[2], reason: 'has_passes' }]);
  });
  it('merge never removes anything', () => {
    expect(diffUnits(live, doc([]).units, 'merge')).toMatchObject({ removed: [], conflicts: [] });
  });
});
