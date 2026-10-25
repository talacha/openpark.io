// Supervisor vehicle enforcement in the real UI, including a linked fine and unlinked photo evidence.
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const API = 'http://localhost:3000', WEB = 'http://localhost:5173';
const sfx = Math.random().toString(36).slice(2, 8);
const shots = process.argv[2] ?? './shots'; mkdirSync(shots, { recursive: true });
const ok = (m) => console.log(`✓ ${m}`);
const call = (path, { token, tenant, method = 'POST', body } = {}) => fetch(API + path, {
  method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenant ? { 'x-tenant': tenant } : {}), ...(method !== 'GET' ? { 'idempotency-key': crypto.randomUUID() } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const j = async (r) => { const body = await r.json(); if (!r.ok) throw new Error(`${r.status}: ${JSON.stringify(body)}`); return body; };
const owner = await call('/v1/signup', { body: { email: `owner-${sfx}@example.com`, password: 'correct-horse-battery', organisation: `Enforcement ${sfx}`, country: 'MX', name: 'Admin' } }).then(j);
const auth = { token: owner.token, tenant: owner.tenant.slug };
await call('/v1/me/profile', { ...auth, method: 'PATCH', body: { locale: 'en' } }).then(j);
await call('/v1/units', { ...auth, body: { code: 'U1', name: 'Unit One' } }).then(j);
const email = `supervisor-${sfx}@example.com`;
const invited = await call('/v1/users', { ...auth, body: { email, roles: ['supervisor'] } }).then(j);
const supervisor = await call('/v1/auth/login', { body: { email, password: invited.temporaryPassword } }).then(j);
await call('/v1/me/profile', { token: supervisor.token, tenant: auth.tenant, method: 'PATCH', body: { locale: 'en' } }).then(j);
const checkIn = async (plate) => call('/v1/sessions', { ...auth, body: { site: 'DEMO-01', plate: { display: plate }, host: { unit: 'U1' } } }).then(j);
await checkIn('VALID1');
const overstay = await checkIn('OVER1');
execSync(`docker exec openpark-pg psql -U openpark -d openpark -c "update session set in_at = now() - interval '13 hours' where id = '${overstay.session.id}'"`);

const b = await chromium.launch({ channel: 'chrome' });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US' });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
await p.goto(`${WEB}/login`);
await p.fill('input[name=email]', email); await p.fill('input[name=password]', invited.temporaryPassword);
await p.click('button.primary'); await p.waitForURL(/dashboard/);
await p.goto(`${WEB}/t/${auth.tenant}/enforcement`);
const entry = p.getByLabel('Plate, ticket or guest pass', { exact: true });
await entry.waitFor();
await p.waitForSelector('video[aria-label="Use camera"]', { state: 'attached' });
await p.getByRole('button', { name: 'Manual entry', exact: true }).click();
await p.waitForSelector('.keypad');
ok('supervisor-only screen opens camera-first and Manual entry swaps in the keypad');

await entry.fill('VALID1'); await p.getByRole('button', { name: 'Check vehicle', exact: true }).click();
await p.waitForSelector('text=Correctly registered');
await p.waitForSelector('text=Assigned box');
ok('valid open stay shows its assigned box');

await entry.fill('OVER1'); await p.getByRole('button', { name: 'Check vehicle', exact: true }).click();
await p.waitForSelector('text=More than 12 hours since check-in');
await p.waitForSelector('text=U1 · Unit One');
await p.screenshot({ path: `${shots}/enforcement-fine.png` });
await p.getByRole('button', { name: /Flag .* fine/ }).click();
await p.waitForSelector('text=Fine recorded for U1.');
ok('overstay flags the responsible department for the 5,000 MXN fine');

await p.getByRole('button', { name: 'Scan another vehicle', exact: true }).click();
await entry.fill('UNKNOWN1'); await p.getByRole('button', { name: 'Check vehicle', exact: true }).click();
await p.waitForSelector('text=No resident or host can be linked to this vehicle.');
const record = p.getByRole('button', { name: 'Record immobilization', exact: true });
if (await record.isEnabled()) throw new Error('immobilization must stay disabled before photo evidence');
await p.setInputFiles('input[type=file]', '/Users/robcr/Projects/openpark.io/apps/web/test/fixtures/plates/mx-abc123.jpg');
await p.waitForSelector('img[src^="data:image/jpeg"]');
await p.screenshot({ path: `${shots}/enforcement-evidence.png` });
await record.click();
await p.waitForSelector('text=Immobilization recorded with photo evidence.');
const evidence = await p.getByRole('link', { name: 'View evidence', exact: true }).getAttribute('href');
const downloaded = await p.request.get(`${WEB}${evidence}`);
if (!downloaded.ok()) throw new Error(`signed evidence download failed: ${downloaded.status()}`);
ok('unlinked vehicle requires a photo, records immobilization, and serves the signed evidence');

const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
if (overflow) throw new Error('enforcement has horizontal overflow on phone');
if (errors.length) throw new Error(errors.join('\n'));
await p.context().close();

const admin = await (await b.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })).newPage();
await admin.goto(`${WEB}/login`);
await admin.fill('input[name=email]', `owner-${sfx}@example.com`); await admin.fill('input[name=password]', 'correct-horse-battery');
await admin.click('button.primary'); await admin.waitForURL(/dashboard/);
await admin.goto(`${WEB}/t/${auth.tenant}/enforcement`); await admin.waitForURL(/dashboard$/);
ok('admins without the supervisor role are redirected away from enforcement');
await b.close();
ok('no page errors or mobile overflow');
