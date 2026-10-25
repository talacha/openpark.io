// Guest-pass story across roles, in the real UI. Needs api :3000 (local auth) and web :5173.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const API = 'http://localhost:3000', WEB = 'http://localhost:5173';
const shots = process.argv[2] ?? './shots'; mkdirSync(shots, { recursive: true });
const sfx = Math.random().toString(36).slice(2, 8);
const ok = (m) => console.log(`✓ ${m}`);
/** Open a menu group only if it is closed (the group you are in is already open). */
async function expand(page, name) {
  const head = page.locator(`button.menu-head:has-text("${name}")`);
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
}

const j = (r) => r.json();
const call = (path, { token, tenant, method = 'POST', body, key } = {}) => fetch(API + path, {
  method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenant ? { 'x-tenant': tenant } : {}), ...(method !== 'GET' ? { 'idempotency-key': key ?? crypto.randomUUID() } : {}) },
  body: body ? JSON.stringify(body) : undefined });

// ---- seed through the API: a Mexican building with an admin, attendant and resident (all English UI) ----
const su = await call('/v1/signup', { body: { email: `owner-${sfx}@example.com`, password: 'correct-horse-battery', organisation: `Torre ${sfx}`, country: 'MX', name: 'Admin' } }).then(j);
const owner = { token: su.token, tenant: su.tenant.slug };
await call('/v1/me/profile', { ...owner, method: 'PATCH', body: { locale: 'en' } });
await call('/v1/units', { ...owner, body: { code: 'A-101', name: 'Apartment A-101' } });
const mk = async (role, extra = {}) => {
  const email = `${role}-${sfx}@example.com`;
  const r = await call('/v1/users', { ...owner, body: { email, roles: [role], ...extra } }).then(j);
  const l = await call('/v1/auth/login', { body: { email, password: r.temporaryPassword } }).then(j);
  await call('/v1/me/profile', { token: l.token, tenant: owner.tenant, method: 'PATCH', body: { locale: 'en' } });
  return { email, password: r.temporaryPassword, token: l.token };
};
const attendant = await mk('attendant');
const resident = await mk('resident', { unit: 'A-101' });
const apiPass = async () => (await call('/v1/passes/active', { token: resident.token, tenant: owner.tenant, method: 'GET' }).then(j)).pass;

const browser = await chromium.launch({ channel: 'chrome' });
const errors = [];
async function login(who, viewport = { width: 420, height: 900 }) {
  const ctx = await browser.newContext({ viewport, locale: 'en-US' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|40[0-9]|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${WEB}/login`);
  await page.fill('input[name=email]', who.email); await page.fill('input[name=password]', who.password);
  await page.click('button.primary');
  return page;
}

// ---- resident ----
const r = await login(resident);
await r.waitForURL(/\/r$/);
await r.waitForSelector('text=Guest parking');
if (await r.locator('text=/Unit Apartment A-101/').count() === 0) throw new Error('resident should see their unit');
ok('resident signs in and lands on the guest-parking app (not the admin console)');

await r.goto(`${WEB}/t/${owner.tenant}/dashboard`);
await r.waitForURL(/\/r$/);
ok('resident is bounced away from the admin console');

await r.click('text=New guest parking pass');
await r.waitForSelector('input[name=guestName]');
await r.fill('input[name=guestName]', 'Luis Invitado');
await r.fill('input[name=guestPhone]', '+525511112222');
if (!(await r.textContent('form:has(input[name=guestName])')).includes('12 hours')) throw new Error('rules should state the 12 hour stay limit');
await r.click('text=Create pass');
await r.waitForSelector('[role=img]');
await r.waitForSelector('text=/QR expires in/');
const left = await r.textContent('.feetotal');
if (!/1:5\d:\d\d|2:00:00/.test(left)) throw new Error(`QR should have ~2h left, got ${left}`);
ok(`pass created with a QR; countdown: ${left.trim()}`);
await r.screenshot({ path: `${shots}/g1-resident-pass.png` });

// one active pass at a time: the create form is gone while a pass is open
if (await r.locator('input[name=guestName]').count()) throw new Error('create form should be hidden while a pass is active');
const dup = await call('/v1/passes', { token: resident.token, tenant: owner.tenant, body: { guestName: 'Otro', guestPhone: '+525533334444' } });
if (dup.status !== 409) throw new Error(`second pass should be refused, got ${dup.status}`);
ok('a second active pass is refused (409)');

// ---- attendant redeems it (typed code: the camera path is covered by the decoder tests) ----
const pass = await apiPass();
const a = await login(attendant);
await a.waitForURL(/\/a$/);
await a.click('.tabbar >> text=Check in');
const checkInEntry = a.getByLabel('Plate or code', { exact: true });
await checkInEntry.fill('OPP1.not-a-real-pass');
await a.click('text=Next');
await a.waitForSelector('.banner.bad');
ok(`junk code rejected: "${(await a.textContent('.banner.bad')).trim()}"`);
await checkInEntry.fill(pass.qr);
await a.click('text=Next');
await a.waitForURL(/\/checkin\/confirm$/);
await a.waitForSelector('text=/Guest pass for Luis Invitado/');
ok('valid pass recognised and taken straight to confirmation');
await a.locator('input[aria-required="true"]').fill('GST123');
await a.screenshot({ path: `${shots}/g2-attendant-pass.png` });
await a.click('text=Confirm check-in');
await a.waitForSelector('.kv dd.num');
const ticket = (await a.textContent('.kv dd.num')).trim();
ok(`guest checked in on a pass; ticket ${ticket}`);
await a.click('text=Done');

// ---- resident sees the guest inside, with the limit and the charge ----
await r.reload();
await r.click('text=New guest parking pass');
await r.waitForSelector('text=/Inside since/');
const rules = await r.textContent('.card');
if (!/\$5,000\.00/.test(await r.textContent('body'))) throw new Error('resident should see the 5,000 MXN HOA charge');
if (await r.locator('text=Cancel pass').count()) throw new Error('cancel must not be offered after check-in');
ok('resident sees "Inside since", the checkout deadline and the $5,000.00 HOA charge; cancel is gone');
await r.screenshot({ path: `${shots}/g3-resident-inside.png` });

// ---- check-out frees the unit ----
await a.click('.tabbar >> text=Check out');
await a.getByLabel('Plate, ticket or guest pass', { exact: true }).fill(ticket);
await a.click('text=Find car');
await a.waitForSelector('.feetotal');
const fee = (await a.textContent('.feetotal')).trim();
if (!/0\.00/.test(fee)) throw new Error(`pass stays are free, got ${fee}`);
await a.click('text=/Confirm leaving/');
await a.waitForSelector('text=/Receipt/');
ok(`guest checked out free of charge (${fee})`);
await r.reload();
await r.click('text=New guest parking pass');
await r.waitForSelector('input[name=guestName]');
await r.click('text=Previous parking passes');
await r.waitForSelector('text=Luis Invitado');
ok('unit is free for a new pass; history shows the completed one');

// ---- cancel before check-in ----
await r.fill('input[name=guestName]', 'Marta');
await r.fill('input[name=guestEmail]', 'marta@example.com');
await r.click('text=Create pass');
await r.waitForSelector('[role=img]');
r.once('dialog', (d) => d.accept());
await r.click('text=Cancel pass');
await r.waitForSelector('input[name=guestName]');
ok('pass cancelled before check-in; unit is free again');

// ---- admin console: units, people, pass rules ----
const adm = await login({ email: `owner-${sfx}@example.com`, password: 'correct-horse-battery' }, { width: 1280, height: 900 });
await adm.waitForURL(/dashboard/);
await expand(adm, 'Admin');
await adm.click('a.nav:has-text("Units")');
await adm.waitForSelector('text=Apartment A-101');
await adm.screenshot({ path: `${shots}/g4-units.png` });
await adm.click('a.nav:has-text("Users")');
await adm.waitForSelector(`text=resident-${sfx}@example.com`);
await adm.screenshot({ path: `${shots}/g5-people.png` });
await expand(adm, 'Platform view');
await adm.click('a.nav:has-text("Guest passes")');
await adm.waitForSelector('text=Pass rules');
const charge = await adm.inputValue('input[type=number][step="0.01"]');
if (Number(charge) !== 5000) throw new Error(`overstay charge should default to 5000 for Mexico, got ${charge}`);
await adm.screenshot({ path: `${shots}/g6-pass-rules.png` });
ok('admin sees units, people and pass rules (overstay charge 5000)');

await browser.close();
if (errors.length) { console.error('Browser errors:\n' + errors.join('\n')); process.exit(1); }
ok('no console errors');
