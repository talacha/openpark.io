import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { generate } from '../generate.mjs';

const answers = JSON.parse(readFileSync(new URL('../answers.example.json', import.meta.url), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(answers));
const dirs = [];
const out = () => { const dir = mkdtempSync(resolve(tmpdir(), 'openpark-single-tenant-')); dirs.push(dir); return dir; };
const read = (dir, name) => JSON.parse(readFileSync(resolve(dir, name), 'utf8'));
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe('single-tenant generator', () => {
  it('creates every required file with the expected sites, apartments, slots, and staff', () => {
    const dir = out();
    const summary = generate(clone(), dir);
    assert.deepEqual(summary, { tenant: 'ahuizotl-residences', sites: 2, units: 42, slots: 99, staff: 2 });
    for (const file of ['inventory.json', 'units.json', 'users.json', 'community.json', 'tenant.json', 'compose.yaml', 'supabase/config.toml']) {
      assert.ok(existsSync(resolve(dir, file)));
    }
    const inventory = read(dir, 'inventory.json');
    assert.equal(inventory.sites.length, 2);
    assert.equal(inventory.sites[0].zones[0].slots.length, 46);
    assert.equal(inventory.sites[0].zones[1].slots.length, 15);
    assert.deepEqual([...new Set(inventory.sites.flatMap((s) => s.zones.flatMap((z) => z.slots.map((slot) => slot.type))))].sort(), ['accessible', 'ev', 'moto', 'standard']);
    assert.equal(read(dir, 'units.json').units.length, 42);
    assert.equal(read(dir, 'users.json').users.length, 2);
    assert.equal(read(dir, 'community.json').communities.length, 1);
    assert.equal(read(dir, 'tenant.json').property.owner.email, 'admin@example.com');
    const compose = readFileSync(resolve(dir, 'compose.yaml'), 'utf8');
    for (const service of ['api', 'web', 'alpr', 'vlm', 'redis', 'migrate']) assert.match(compose, new RegExp(`  ${service}:`));
    assert.doesNotMatch(compose, /models:\/models/);
    assert.match(compose, /Dockerfile.alpr-single-tenant/);
    assert.match(compose, /context: \.\.\/\.\.\/\.\./);
  });

  it('supports all-standard floors and unique sequential slot codes', () => {
    const input = clone();
    Object.assign(input.buildings[0].floors[0].slots, { accessible: 0, moto: 0, ev: 0 });
    const dir = out();
    generate(input, dir);
    const slots = read(dir, 'inventory.json').sites[0].zones[0].slots;
    assert.equal(new Set(slots.map((slot) => slot.type)).size, 1);
    assert.equal(slots[0].type, 'standard');
    assert.equal(new Set(slots.map((slot) => slot.code)).size, slots.length);
  });

  it('rejects a floor with no slots and duplicate apartment codes', () => {
    const empty = clone();
    Object.assign(empty.buildings[0].floors[0].slots, { standard: 0, accessible: 0, moto: 0, ev: 0 });
    assert.throws(() => generate(empty, out()), /at least one slot/);
    const duplicate = clone();
    duplicate.buildings[1].units = { prefix: 'A', start: 101, count: 1 };
    assert.throws(() => generate(duplicate, out()), /Duplicate unit code/);
  });

  it('does not write credentials into the generated configuration', () => {
    const dir = out();
    generate(clone(), dir);
    const files = ['inventory.json', 'units.json', 'users.json', 'community.json', 'tenant.json', 'compose.yaml', 'supabase/config.toml'];
    const contents = files.map((file) => readFileSync(resolve(dir, file), 'utf8')).join('\n');
    assert.doesNotMatch(contents, /service_role|correct-horse-battery|change-me-owner/);
    assert.equal(read(dir, 'tenant.json').property.owner.password, undefined);
  });
});
