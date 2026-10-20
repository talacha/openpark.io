import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PlateRegion } from '@openpark/core';

/** Loads the Apache-2.0 plate-format registry (one JSON file per region). */
export function loadPlateRegistry(dir = fileURLToPath(new URL('../../../registry/plates/', import.meta.url))): Map<string, PlateRegion> {
  const out = new Map<string, PlateRegion>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const r = PlateRegion.parse(JSON.parse(readFileSync(dir + f, 'utf8')));
    out.set(r.region, r);
  }
  return out;
}
