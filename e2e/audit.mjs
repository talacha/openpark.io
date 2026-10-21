// Review crawl: every screen, as every role, on desktop and phone, in the pseudo-locale and Arabic. Reports problems; fixes nothing.
// Needs api :3000 (TRIAL_SIGNUP=true), web :5173 and the openpark-pg container (to mark one user a super admin).
import { execSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const API = 'http://localhost:3000', WEB = 'http://localhost:5173';
const sfx = Math.random().toString(36).slice(2, 8);
const j = (r) => r.json();
const call = (path, { token, tenant, method = 'POST', body } = {}) => fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenant ? { 'x-tenant': tenant } : {}), ...(method !== 'GET' ? { 'idempotency-key': crypto.randomUUID() } : {}) }, body: body ? JSON.stringify(body) : undefined });

const su = await call('/v1/signup', { body: { email: `owner-${sfx}@example.com`, password: 'correct-horse-battery', organisation: `Audit ${sfx}`, country: 'MX' } }).then(j);
const T = su.tenant.slug; const owner = { token: su.token, tenant: T };
await call('/v1/units', { ...owner, body: { code: 'U1', name: 'Unit 1' } });
const people = { owner: { email: `owner-${sfx}@example.com`, password: 'correct-horse-battery', token: su.token } };
for (const role of ['admin', 'supervisor', 'attendant', 'resident']) {
  const email = `${role}-${sfx}@example.com`;
  const r = await call('/v1/users', { ...owner, body: { email, roles: [role], ...(role === 'resident' ? { unit: 'U1' } : {}) } }).then(j);
  const l = await call('/v1/auth/login', { body: { email, password: r.temporaryPassword } }).then(j);
  people[role] = { email, password: r.temporaryPassword, token: l.token };
}
execSync(`docker exec openpark-pg psql -U openpark -d openpark -c "update app_user set is_superadmin = true where email = 'owner-${sfx}@example.com'"`, { stdio: 'ignore' });
// Realistic data so tables and forms have content: a car inside, a pass.
await call('/v1/sessions', { ...owner, body: { site: 'DEMO-01', plate: { display: 'AUD123' } } });
await call('/v1/passes', { token: people.resident.token, tenant: T, body: { guestName: 'Gx', guestPhone: '+525511112222' } });

const ROUTES = {
  owner: ['dashboard', 'sessions', 'slots', 'passes', 'queue', 'rates', 'inventory', 'units', 'users', 'ai', 'locale', 'a', 'a/checkin', 'a/checkout', '!platform'],
  supervisor: ['dashboard', 'sessions', 'slots', 'passes', 'queue'],
  attendant: ['a', 'a/checkin', 'a/checkout', 'queue'],
  resident: ['r'],
};
const findings = new Map();
const flag = (kind, where, detail) => { const k = `${kind}|${where}|${detail}`; findings.set(k, { kind, where, detail }); };

const b = await chromium.launch({ channel: 'chrome' });
const VIEWPORTS = [['desktop', 1280, 900], ['phone', 360, 740]];
const MODES = ['en', 'en-XA', 'ar'];

for (const role of Object.keys(ROUTES)) for (const [vp, w, h] of VIEWPORTS) for (const mode of MODES) {
  if (mode !== 'en' && vp === 'phone' && role !== 'owner' && role !== 'resident') continue; // keep the run short
  const ctx = await b.newContext({ viewport: { width: w, height: h }, locale: 'en-US' });
  await ctx.addInitScript((m) => { try { localStorage.setItem('op.locale', m); } catch {} }, mode);
  const p = await ctx.newPage();
  let where = ''; 
  p.on('pageerror', (e) => flag('page-error', where, String(e).slice(0, 160)));
  p.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) flag('console-error', where, m.text().slice(0, 160)); });
  p.on('response', (r) => { const u = r.url(); if (u.startsWith(API) || u.includes('/v1/')) { if (r.status() >= 400 && ![401].includes(r.status())) flag('http-' + r.status(), where, `${r.request().method()} ${u.replace(/^https?:\/\/[^/]+/, '').split('?')[0]}`); } });
  await p.goto(`${WEB}/login`); await p.fill('input[name=email]', people[role].email); await p.fill('input[name=password]', people[role].password); await p.click('button.primary');
  await p.waitForSelector('.menu-nav', { state: 'attached' });
  for (const r of ROUTES[role]) {
    const url = r.startsWith('!') ? `${WEB}/${r.slice(1)}` : `${WEB}/t/${T}/${r}`;
    where = `${role}/${vp}/${mode}/${r}`;
    await p.goto(url); await p.waitForTimeout(700);
    const res = await p.evaluate(() => {
      const out = {};
      out.overflow = document.documentElement.scrollWidth - window.innerWidth;
      out.rtl = document.documentElement.dir;
      const named = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || (el.labels && el.labels.length) || (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label'));
      out.unlabeled = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].filter((el) => !named(el)).map((el) => `${el.tagName.toLowerCase()}[name=${el.name || ''}][type=${el.type}]`);
      out.emptyButtons = [...document.querySelectorAll('button, a[href]')].filter((el) => !el.textContent.trim() && !el.getAttribute('aria-label') && !el.title && !el.querySelector('img[alt]')).map((el) => el.className || el.tagName);
      const ids = [...document.querySelectorAll('[id]')].map((e) => e.id); out.dupIds = ids.filter((x, i) => ids.indexOf(x) !== i);
      out.labelInLabel = document.querySelectorAll('label label').length;
      // text nodes that are not bracketed by the pseudo-locale = candidates for hardcoded strings
      const hard = new Set();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.textContent.trim(); const el = n.parentElement;
        if (!t || !/[A-Za-z]{3,}/.test(t) || el.closest('script,style,svg,.plate,option,code,[dir=ltr],textarea')) continue;
        if (t.startsWith('[') ) continue;
        hard.add(t.slice(0, 60));
      }
      out.hard = [...hard];
      return out;
    });
    if (res.overflow > 0) flag('horizontal-overflow', where, `${res.overflow}px`);
    for (const u of res.unlabeled) flag('unlabeled-field', where, u);
    for (const e of res.emptyButtons) flag('unnamed-control', where, e);
    for (const d of res.dupIds) flag('duplicate-id', where, d);
    if (res.labelInLabel) flag('label-in-label', where, String(res.labelInLabel));
    if (mode === 'en-XA') for (const t of res.hard) flag('hardcoded-text', `${role}/${r}`, t);
    if (mode === 'ar' && res.rtl !== 'rtl') flag('rtl-not-set', where, res.rtl);
  }
  await ctx.close();
}
await b.close();

const groups = {};
for (const f of findings.values()) (groups[f.kind] ??= []).push(f);
console.log(`\n${findings.size} distinct findings`);
for (const [k, list] of Object.entries(groups)) { console.log(`\n## ${k} (${list.length})`); for (const f of list.slice(0, 60)) console.log(`  ${f.where}  ${f.detail}`); }
