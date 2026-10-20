import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { InventoryDoc, flattenInventory } from '../src/index.js';

const root = new URL('../../../', import.meta.url);
const schema = JSON.parse(readFileSync(new URL('schemas/inventory/v1.json', root), 'utf8'));
const validate = addFormats(new (Ajv2020 as unknown as typeof Ajv2020.default)({ allErrors: true })).compile(schema);

/** The example in ARCHITECTURE.md is the contract: it must satisfy the published schema and the importer. */
const arch = readFileSync(new URL('ARCHITECTURE.md', root), 'utf8');
const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(arch)![1]!);

describe('inventory JSON Schema v1', () => {
  it('accepts the example from ARCHITECTURE.md', () => {
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
  });
  it('agrees with the Zod importer on that example (and expands it to 93 slots, B2-003-style overrides included)', () => {
    expect(flattenInventory(InventoryDoc.parse(example))).toHaveLength(80 + 1 + 1 + 1 + 12);
  });
  it('rejects the same mistakes the importer rejects', () => {
    const bad = (mut: (d: any) => void) => { const d = structuredClone(example); mut(d); return d; };
    const cases = [
      bad((d) => { d.schemaVersion = 2; }),
      bad((d) => { delete d.sites[0].timezone; }),
      bad((d) => { d.sites[0].zones[0].slots.push({ type: 'standard' }); }),
      bad((d) => { d.sites[0].zones[0].slots.push({ code: 'X', range: 'A-1..A-2', type: 'standard' }); }),
      bad((d) => { d.sites[0].zones[0].slots.push({ code: 'X', type: 'standard', status: 'broken' }); }),
    ];
    for (const c of cases) {
      expect(validate(c)).toBe(false);
      expect(InventoryDoc.safeParse(c).success).toBe(false);
    }
  });
  it('allows x- extension keys at any level', () => {
    const d = structuredClone(example);
    d['x-client'] = { id: 1 }; d.sites[0]['x-owner'] = 'ops'; d.sites[0].zones[0].slots[1]['x-meter'] = 'M-7';
    expect(validate(d), JSON.stringify(validate.errors)).toBe(true);
    expect(InventoryDoc.safeParse(d).success).toBe(true);
  });
});
