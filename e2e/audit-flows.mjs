// Interaction review: walks real flows, including failures, in the pseudo-locale (every translated string is wrapped in [ ]),
// so any unbracketed English on screen is hardcoded or comes untranslated from the server. Reports; fixes nothing.
import { execSync } from 'node:child_process';
import { chromium } from 'playwright-core';
const API = 'http://localhost:3000', WEB = 'http://localhost:5173';
const sfx = Math.random().toString(36).slice(2, 8);
const j = (r) => r.json();
const call = (path, { token, tenant, method = 'POST', body } = {}) => fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenant ? { 'x-tenant': tenant } : {}), ...(method !== 'GET' ? { 'idempotency-key': crypto.randomUUID() } : {}) }, body: body ? JSON.stringify(body) : undefined });
const su = await call('/v1/signup', { body: { email: `owner-${sfx}@example.com`, password: 'correct-horse-battery', organisation: `Flow ${sfx}`, country: 'MX' } }).then(j);
const T = su.tenant.slug; const owner = { token: su.token, tenant: T };
await call('/v1/units', { ...owner, body: { code: 'U1', name: 'Unit 1' } });
const people = { owner: { email: `owner-${sfx}@example.com`, password: 'correct-horse-battery' } };
for (const role of ['attendant', 'resident', 'supervisor']) {
  const email = `${role}-${sfx}@example.com`;
  const r = await call('/v1/users', { ...owner, body: { email, roles: [role], ...(role === 'resident' ? { unit: 'U1' } : {}) } }).then(j);
  people[role] = { email, password: r.temporaryPassword };
}
execSync(`docker exec openpark-pg psql -U openpark -d openpark -c "update app_user set is_superadmin = true where email = 'owner-${sfx}@example.com'"`, { stdio: 'ignore' });
await call('/v1/sessions', { ...owner, body: { site: 'DEMO-01', plate: { display: 'FLW111' } } });

const findings = new Map();
const flag = (where, text) => findings.set(`${where}|${text}`, { where, text });
const b = await chromium.launch({ channel: 'chrome' });

async function session(role, vp = [390, 844], mode = 'en-XA') {
  const ctx = await b.newContext({ viewport: { width: vp[0], height: vp[1] }, locale: 'en-US' });
  await ctx.addInitScript((m) => { try { localStorage.setItem('op.locale', m); } catch {} }, mode);
  const p = await ctx.newPage();
  p.on('dialog', (d) => d.accept('reason'));
  p.on('pageerror', (e) => flag(`${role}: page error`, String(e).slice(0, 140)));
  p.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) flag(`${role}: console`, m.text().slice(0, 140)); });
  await p.goto(`${WEB}/login`); await p.fill('input[name=email]', people[role].email); await p.fill('input[name=password]', people[role].password); await p.click('button.primary');
  await p.waitForSelector('.menu-nav', { state: 'attached' });
  return p;
}
/** Text on screen that is not wrapped by the pseudo-locale, ignoring data (names, plates, numbers, codes). */
async function scan(p, where) {
  const texts = await p.evaluate(() => {
    const out = new Set();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.textContent.trim(); const el = n.parentElement;
      if (!t || !/[A-Za-z]{3,}/.test(t) || el.closest('script,style,svg,.plate,code,textarea,.menu-org')) continue;
      if (t.startsWith('[') || /^[A-Z0-9 _.:@+/-]+$/.test(t)) continue;
      out.add(t.slice(0, 90));
    }
    // <select> choices are not text nodes we can wrap: list lower-case raw values separately
    document.querySelectorAll('option').forEach((o) => { const t = o.textContent.trim(); if (/^[a-z_ ]{3,}$/.test(t)) out.add(`option: ${t}`); });
    return [...out];
  });
  for (const t of texts) flag(where, t);
}
const click = (p, sel) => p.click(sel);
const type = async (p, s) => { await p.click('[data-mode=keypad]').catch(() => {}); for (const c of s) await p.click(`.keypad button[aria-label="${c}"]`); };
const pause = (p, ms = 500) => p.waitForTimeout(ms);

// ---------------- logged out: auth errors ----------------
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US' });
  await ctx.addInitScript(() => { try { localStorage.setItem('op.locale', 'en-XA'); } catch {} });
  const p = await ctx.newPage();
  await p.goto(`${WEB}/login`); await p.fill('input[name=email]', 'nobody@example.com'); await p.fill('input[name=password]', 'wrong-password'); await p.click('button.primary'); await pause(p); await scan(p, 'login: wrong password');
  await p.goto(`${WEB}/signup`); await pause(p, 700); await scan(p, 'signup page');
  await p.fill('input[name=name]', 'X'); await p.fill('input[name=org]', 'Dup Org'); await p.fill('input[name=email]', people.owner.email); await p.fill('input[name=password]', 'correct-horse-battery'); await p.click('button.primary'); await pause(p, 800); await scan(p, 'signup: email taken');
  await ctx.close();
}

// ---------------- attendant, phone ----------------
{
  const p = await session('attendant');
  await p.goto(`${WEB}/t/${T}/a`); await pause(p, 700); await scan(p, 'attendant home');
  await p.goto(`${WEB}/t/${T}/a/checkin`); await pause(p); await scan(p, 'check-in capture');
  await p.fill('input[aria-label*="ass code" i], input[placeholder]', 'OPP1.bogus').catch(() => {});
  await p.locator('.card button').filter({ hasText: /\[/ }).nth(1).click().catch(() => {}); await pause(p); await scan(p, 'check-in: bad pass code');
  await type(p, 'GST123'); await p.click('.btn.primary.big'); await pause(p, 700); await scan(p, 'check-in confirm');
  await p.click('.btn.primary.big'); await p.waitForSelector('.kv dd.num'); await pause(p, 400); await scan(p, 'check-in ticket');
  const ticket = (await p.textContent('.kv dd.num')).trim();
  await p.click('.btn.primary.big'); await pause(p);
  // duplicate
  await p.goto(`${WEB}/t/${T}/a/checkin`); await type(p, 'GST123'); await p.click('.btn.primary.big'); await pause(p, 600); await p.click('.btn.primary.big'); await pause(p, 800); await scan(p, 'check-in: already inside');
  // checkout: bogus then real
  await p.goto(`${WEB}/t/${T}/a/checkout`); await pause(p);
  await p.getByRole('textbox').nth(0).fill('NOSUCH99'); await p.locator('.btn.primary.big').click(); await pause(p, 800); await scan(p, 'check-out: no match');
  await p.getByRole('textbox').nth(0).fill(ticket); await p.locator('.btn.primary.big').click(); await p.waitForSelector('.feetotal'); await pause(p, 300); await scan(p, 'check-out review');
  await p.locator('.btn.primary.big').click(); await pause(p, 800); await scan(p, 'check-out receipt');
  await p.goto(`${WEB}/t/${T}/queue`); await pause(p); await scan(p, 'sync queue');
  await p.context().close();
}

// ---------------- resident, phone ----------------
{
  const p = await session('resident');
  await p.goto(`${WEB}/t/${T}/r`); await pause(p, 800); await scan(p, 'resident: no pass yet');
  await p.fill('input[name=guestName]', 'Gx'); await p.fill('input[name=guestPhone]', '+525511112222'); await p.locator('form:has(input[name=guestName]) button.primary').click(); await p.waitForSelector('[role=img]'); await pause(p, 400); await scan(p, 'resident: active pass');
  // second pass attempt is blocked in the UI; provoke the server error through the API-backed regenerate/cancel path instead
  await p.locator('button.danger').click(); await p.waitForSelector('input[name=guestName]'); await pause(p, 500); await scan(p, 'resident: after cancel');
  await p.context().close();
}

// ---------------- owner, desktop ----------------
{
  const p = await session('owner', [1280, 900]);
  await p.goto(`${WEB}/t/${T}/sessions`); await pause(p, 700); await p.locator('tbody tr.click').first().click(); await pause(p, 500); await scan(p, 'sessions + timeline');
  await p.goto(`${WEB}/t/${T}/slots`); await pause(p, 700); await p.locator('.slot').first().click(); await pause(p, 300); await scan(p, 'slots: selected slot');
  await p.goto(`${WEB}/t/${T}/rates`); await pause(p, 700); await p.getByRole('button').filter({ hasText: /\[/ }).nth(1).click().catch(() => {}); await pause(p, 700); await scan(p, 'rates + simulator');
  await p.goto(`${WEB}/t/${T}/units`); await pause(p, 700);
  await p.fill('input[name=code]', 'U1'); await p.fill('input[name=name]', 'Dup'); await p.locator('form.card.row button.primary').click(); await pause(p, 700); await scan(p, 'units: duplicate code');
  await p.goto(`${WEB}/t/${T}/users`); await pause(p, 700);
  await p.fill('input[name=email]', people.attendant.email); await p.locator('form.card button.primary').click(); await pause(p, 700); await scan(p, 'people: already a member');
  await p.goto(`${WEB}/t/${T}/inventory`); await pause(p, 700); await p.fill('textarea', '{"schemaVersion":1,"sites":[,]}'); await p.locator('button.primary').first().click(); await pause(p, 700); await scan(p, 'inventory: bad json');
  await p.goto(`${WEB}/t/${T}/ai`); await pause(p, 700); await scan(p, 'ai settings');
  await p.goto(`${WEB}/t/${T}/locale`); await pause(p, 700); await scan(p, 'localization');
  await p.goto(`${WEB}/t/${T}/passes`); await pause(p, 700); await scan(p, 'guest passes');
  await p.goto(`${WEB}/platform`); await pause(p, 800); await scan(p, 'organisations');
  await p.fill('input[name=org]', 'Dup'); await p.fill('input[name=owner]', people.owner.email); await p.locator('form.card button.primary').click(); await pause(p, 800); await scan(p, 'organisations: create result');
  await p.context().close();
}
await b.close();
const byWhere = {};
for (const f of findings.values()) (byWhere[f.where] ??= []).push(f.text);
console.log(`\n${findings.size} findings`);
for (const [w, l] of Object.entries(byWhere)) { console.log(`\n## ${w}`); l.forEach((t) => console.log('   ' + t)); }
