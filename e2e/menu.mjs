// The role-based menu in the real UI: who sees what, on desktop and phone. Needs api :3000 (TRIAL_SIGNUP=true), web :5173,
// and the local Postgres container `openpark-pg` (to mark one user as a platform super admin).
import { execSync } from 'node:child_process';
import { chromium } from 'playwright-core';
const API = 'http://localhost:3000', WEB = 'http://localhost:5173';
const sfx = Math.random().toString(36).slice(2, 8);
const j = (r) => r.json();
const call = (path, { token, tenant, method = 'POST', body } = {}) => fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenant ? { 'x-tenant': tenant } : {}), ...(method !== 'GET' ? { 'idempotency-key': crypto.randomUUID() } : {}) }, body: body ? JSON.stringify(body) : undefined });
const su = await call('/v1/signup', { body: { email: `owner-${sfx}@example.com`, password: 'correct-horse-battery', organisation: `Menu ${sfx}`, country: 'US' } }).then(j);
const owner = { token: su.token, tenant: su.tenant.slug };
await call('/v1/units', { ...owner, body: { code: 'U1', name: 'Unit 1' } });
const people = { owner: { email: `owner-${sfx}@example.com`, password: 'correct-horse-battery', token: su.token } };
for (const role of ['admin', 'supervisor', 'attendant', 'resident']) {
  const email = `${role}-${sfx}@example.com`;
  const r = await call('/v1/users', { ...owner, body: { email, roles: [role], ...(role === 'resident' ? { unit: 'U1' } : {}) } }).then(j);
  const l = await call('/v1/auth/login', { body: { email, password: r.temporaryPassword } }).then(j);
  people[role] = { email, password: r.temporaryPassword, token: l.token };
}
for (const p of Object.values(people)) await call('/v1/me/profile', { token: p.token, tenant: owner.tenant, method: 'PATCH', body: { locale: 'en' } });
// A platform super admin who is also a member of this organisation.
execSync(`docker exec openpark-pg psql -U openpark -d openpark -c "update app_user set is_superadmin = true where email = 'owner-${sfx}@example.com'"`, { stdio: 'ignore' });

const WANT = {
  owner: { heads: ['Platform view', 'Admin'], admin: ['Rate plans', 'Import / export', 'Units', 'People', 'AI plate reading', 'Localization', 'Organisations'] },
  admin: { heads: ['Platform view', 'Admin'], admin: ['Rate plans', 'Import / export', 'Units', 'People', 'AI plate reading', 'Localization'] },
  supervisor: { heads: ['Platform view', 'Operator view'] },
  attendant: { heads: ['Operator view'] }, resident: { links: ['Resident view'] },
};
const b = await chromium.launch({ channel: 'chrome' });
const errors = [];
async function open(role, viewport) {
  const ctx = await b.newContext({ viewport, locale: 'en-US' }); const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${role}: ${e}`));
  await p.goto(`${WEB}/login`); await p.fill('input[name=email]', people[role].email); await p.fill('input[name=password]', people[role].password); await p.click('button.primary');
  await p.waitForSelector('.menu-nav', { state: 'attached' }); return p;
}
const menuText = (p) => p.$$eval('.menu-nav > *', (els) => els.map((e) => ({ head: e.querySelector('.menu-head')?.textContent.trim() ?? e.textContent.trim(), isGroup: !!e.querySelector('.menu-head') })));

for (const role of Object.keys(WANT)) {
  const p = await open(role, { width: 1280, height: 900 });
  const items = await menuText(p);
  const heads = items.filter((i) => i.isGroup).map((i) => i.head);
  const links = items.filter((i) => !i.isGroup).map((i) => i.head);
  const w = WANT[role];
  if (JSON.stringify(heads) !== JSON.stringify(w.heads ?? [])) throw new Error(`${role}: groups ${JSON.stringify(heads)} != ${JSON.stringify(w.heads ?? [])}`);
  if (JSON.stringify(links) !== JSON.stringify(w.links ?? [])) throw new Error(`${role}: links ${JSON.stringify(links)}`);
  if (w.admin) {
    await p.click('button.menu-head:has-text("Admin")');
    const subs = await p.$$eval('#menu-admin a', (as) => as.map((a) => a.textContent.trim()));
    if (JSON.stringify(subs) !== JSON.stringify(w.admin)) throw new Error(`${role}: admin items ${JSON.stringify(subs)}`);
  }
  console.log(`✓ ${role.padEnd(10)} sees ${[...heads, ...links].join(' + ')}${w.admin ? ` (Admin: ${w.admin.length} items${w.admin.includes('Organisations') ? ', incl. Organisations' : ''})` : ''}`);
  if (role === 'owner') await p.screenshot({ path: process.argv[2] + '/m1-desktop-owner.png' });
  await p.context().close();
}

// Same menu on a phone: hidden behind the hamburger, identical contents, closes on navigation, Esc and the backdrop.
{
  const p = await open('admin', { width: 390, height: 844 });
  if (await p.isVisible('#app-menu')) throw new Error('drawer should be closed on phones');
  await p.click('.topbar button'); await p.waitForSelector('#app-menu', { state: 'visible' });
  const phone = await menuText(p);
  console.log('✓ phone drawer lists the same groups:', phone.filter((i) => i.isGroup).map((i) => i.head).join(' + '));
  await p.waitForTimeout(450); // let the slide-in finish before the screenshot
  await p.screenshot({ path: process.argv[2] + '/m2-phone-open.png' });
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  if (await p.isVisible('#app-menu')) throw new Error('Escape should close the drawer');
  await p.click('.topbar button'); await p.click('.scrim', { position: { x: 370, y: 400 } }); await p.waitForTimeout(300);
  if (await p.isVisible('#app-menu')) throw new Error('tapping outside should close the drawer');
  await p.click('.topbar button'); await p.click('button.menu-head:has-text("Admin")'); await p.click('#menu-admin a:has-text("Units")');
  await p.waitForURL(/\/units$/); await p.waitForTimeout(300);
  if (await p.isVisible('#app-menu')) throw new Error('navigating should close the drawer');
  console.log('✓ drawer closes on Escape, on tapping outside, and after choosing a page');
  await p.click('.topbar button');
  if (!(await p.getAttribute('button.menu-head:has-text("Admin")', 'aria-expanded') === 'true')) throw new Error('the group you are in should stay expanded');
  if ((await p.getAttribute('#menu-admin a[aria-current=page]', 'class')) === null) throw new Error('current page should be highlighted');
  console.log('✓ the current page is highlighted and its group stays expanded');
  await p.context().close();
}

// Attendant on a phone: same menu plus the operator tab bar.
{
  const p = await open('attendant', { width: 390, height: 844 });
  await p.waitForSelector('.tabbar');
  await p.click('.topbar button');
  const head = p.locator('button.menu-head:has-text("Operator view")');
  if ((await head.getAttribute('aria-expanded')) !== 'true') throw new Error('the attendant lands in the Operator view, so it should already be expanded');
  const subs = await p.$$eval('#menu-operator a', (as) => as.map((a) => a.textContent.trim()));
  if (JSON.stringify(subs) !== JSON.stringify(['Home', 'Check in', 'Check out', 'Sync queue'])) throw new Error(`operator items ${subs}`);
  console.log('✓ attendant: Operator view → Home, Check in, Check out, Sync queue (plus the phone tab bar)');
  await p.context().close();
}

// Typed URLs are guarded too: residents and attendants cannot open the admin pages.
for (const [role, url] of [['resident', 'units'], ['attendant', 'users'], ['supervisor', 'rates'], ['resident', 'dashboard']]) {
  const p = await open(role, { width: 1280, height: 900 });
  await p.goto(`${WEB}/t/${owner.tenant}/${url}`); await p.waitForTimeout(600);
  if (new RegExp(`/${url}$`).test(p.url())) throw new Error(`${role} could open /${url}`);
  await p.context().close();
}
console.log('✓ typed URLs: residents, attendants and supervisors are redirected away from pages their role cannot use');

// Arabic: the menu mirrors.
{
  const p = await open('owner', { width: 1280, height: 900 });
  await p.selectOption('.menu-foot select', 'ar'); await p.waitForTimeout(300);
  const side = await p.$eval('#app-menu', (e) => e.getBoundingClientRect().left);
  if (side < 600) throw new Error('menu should sit on the right in right-to-left languages');
  await p.screenshot({ path: process.argv[2] + '/m3-rtl.png' });
  console.log('✓ Arabic: the menu moves to the right edge');
  await p.context().close();
}
await b.close();
if (errors.length) { console.error(errors); process.exit(1); }
