// Units JSON import/export in the real UI. Needs api :3000 (TRIAL_SIGNUP=true) and web :5173.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const API = 'http://localhost:3000', WEB = 'http://localhost:5173';
const sfx = Math.random().toString(36).slice(2, 8);
const su = await fetch(`${API}/v1/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `u-${sfx}@example.com`, password: 'correct-horse-battery', organisation: `Units ${sfx}`, country: 'MX' }) }).then((r) => r.json());
await fetch(`${API}/v1/me/profile`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${su.token}`, 'x-tenant': su.tenant.slug }, body: JSON.stringify({ locale: 'en' }) });
const b = await chromium.launch({ channel: 'chrome' });
const ctx = await b.newContext({ viewport: { width: 1200, height: 1000 }, locale: 'en-US', acceptDownloads: true });
const p = await ctx.newPage(); const errs = [];
p.on('response', async (r) => { if (r.url().includes('/units/import') && r.request().method() === 'POST') console.log('  ·', r.status(), (await r.text()).slice(0, 260).replace(/\s+/g, ' ')); }); p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(`${WEB}/login`); await p.fill('input[name=email]', `u-${sfx}@example.com`); await p.fill('input[name=password]', 'correct-horse-battery'); await p.click('button.primary');
await p.waitForURL(/dashboard/); await p.click('button.menu-head:has-text("Admin")'); await p.click('a.nav:has-text("Units")'); await p.waitForSelector('text=Import units from JSON');

const rez = `rosa-${sfx}@example.com`;
const file = { schemaVersion: 1, tenant: su.tenant.slug, units: [
  { code: 'A-101', name: 'Apartment A-101', site: 'DEMO-01', residents: [{ email: rez, name: 'Rosa' }] }, { code: 'A-102', name: 'Apartment A-102' } ] };
await p.fill('textarea', JSON.stringify(file));
await p.click('text=Validate and preview');
await p.waitForSelector('text=/\\+2 Added/'); await p.waitForSelector(`text=${rez}`);
console.log('✓ preview shows 2 added units and the resident to add');
await p.screenshot({ path: process.argv[2] + '/u1-preview.png' });
await p.click('button:has-text("Apply")');
await p.waitForSelector('text=Import applied');
const banner = await p.textContent('.banner[role=status]');
if (!/Temporary password/.test(banner)) throw new Error('local auth should show the one-time password');
console.log('✓ applied; one-time password shown for the new resident');
await p.waitForSelector('tbody >> text=Apartment A-102');
await p.screenshot({ path: process.argv[2] + '/u2-applied.png' });

const [dl] = await Promise.all([p.waitForEvent('download'), p.click('button:has-text("Export JSON")')]);
const exported = JSON.parse(readFileSync(await dl.path(), 'utf8'));
if (exported.units.length !== 2 || exported.units[0].residents[0].email !== rez) throw new Error('export should contain the imported units and resident');
console.log('✓ export downloads units.json with', exported.units.length, 'units');

await p.fill('textarea', JSON.stringify(exported)); await p.selectOption('select >> nth=0', 'replace').catch(() => {});
await p.click('text=Validate and preview'); await p.waitForSelector('text=No changes');
console.log('✓ re-importing the export reports no changes');
await p.fill('textarea', '{\n "schemaVersion": 1,\n "units": [,]\n}'); await p.click('text=Validate and preview'); await p.waitForSelector('.banner.bad');
console.log('✓ bad JSON reported:', (await p.textContent('.banner.bad')).trim().slice(0, 70));
await b.close(); if (errs.length) { console.error(errs); process.exit(1); }
