import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PlateRegion } from '@openpark/core';

const CANDIDATES = [
  '../../../registry/plates/', // monorepo checkout
  '../registry/plates/', // copied next to the API by the build (Vercel bundles only the project root)
];

/** Loads the Apache-2.0 plate-format registry (one JSON file per region). */
export function loadPlateRegistry(override?: string): Map<string, PlateRegion> {
  const dir = override ?? CANDIDATES.map((c) => fileURLToPath(new URL(c, import.meta.url))).find((d) => existsSync(d));
  if (!dir) throw new Error('plate registry not found; set REGISTRY_DIR');
  const base = dir.endsWith('/') ? dir : `${dir}/`;
  const out = new Map<string, PlateRegion>();
  for (const f of readdirSync(base).filter((x) => x.endsWith('.json'))) {
    const r = PlateRegion.parse(JSON.parse(readFileSync(base + f, 'utf8')));
    out.set(r.region, r);
  }
  return out;
}
