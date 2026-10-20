import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PlateRegion, correctConfusables, matchPlateClass, normalizePlate, plateDistance } from '../src/index.js';

const load = (r: string) => PlateRegion.parse(JSON.parse(readFileSync(new URL(`../../../registry/plates/${r}.json`, import.meta.url), 'utf8')));
const MX = load('MX');

describe('normalizePlate', () => {
  it('uppercases and strips separators', () => expect(normalizePlate('abc-123 d')).toBe('ABC123D'));
  it('folds full-width characters', () => expect(normalizePlate('ＡＢＣ１２３')).toBe('ABC123'));
  it('folds Eastern Arabic digits', () => {
    expect(normalizePlate('١٢٣')).toBe('123');
    expect(normalizePlate('۱۲۳')).toBe('123');
  });
});

describe('registry', () => {
  it('validates Mexican plates', () => {
    expect(matchPlateClass(MX, 'ABC123')).toBe('private');
    expect(matchPlateClass(MX, 'ABC12')).toBeNull();
  });
  it('corrects confusables only where the pattern then validates', () => {
    expect(correctConfusables(MX, 'ABC12O')).toBe('ABC120');
    expect(correctConfusables(MX, 'AB!123')).toBeNull();
  });
  it('loads every registry file', () => {
    for (const r of ['MX', 'US', 'BR', 'DE', 'ES', 'FR']) expect(load(r).patterns.length).toBeGreaterThan(0);
  });
});

describe('plateDistance', () => {
  it('weights confusable swaps lightly', () => {
    expect(plateDistance('ABC123', 'ABC123')).toBe(0);
    expect(plateDistance('ABC123', 'ABC12Z')).toBe(1);
    expect(plateDistance('ABCO23', 'ABC023', MX.confusables)).toBe(0.25);
  });
});
