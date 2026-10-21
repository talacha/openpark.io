// People screen: role checkboxes (least → most access), edit, pending-invite edit/delete, Super Admin and the property toggle.
// Needs api :3000 (TRIAL_SIGNUP=true), web :5173 and the local Postgres container `openpark-pg`.
import { execSync } from 'node:child_process';
import { chromium } from 'playwright-core';
const API = 'http://localhost:3000', WEB = 'http://localhost:5173';
const sfx = Math.random().toString(36).slice(2, 8);
const call = (path, { token, tenant, method = 'POST', body } = {}) => fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenant ? { 'x-tenant': tenant } : {}), ...(method !== 'GET' ? { 'idempotency-key': crypto.randomUUID() } : {}) }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const mk = async (name) => { const su = await call('/v1/signup', { body: { email: `${name}-${sfx}@example.com`, password: 'correct-horse-battery', organisation: `${name} ${sfx}`, country: 'US' } }); await call('/v1/me/profile', { method: 'PATCH', token: su.token, tenant: su.tenant.slug, body: { locale: 'en' } }); return su; };
const ok = (c, m) => { if (!c) throw new Error(m); console.log('✓ ' + m); };

const su = await mk('root'); const other = await mk('other');
await call('/v1/units', { token: su.token, tenant: su.tenant.slug, body: { code: 'U1', name: 'Unit 1' } });
await call('/v1/units', { token: su.token, tenant: su.tenant.slug, body: { code: 'U2', name: 'Unit 2' } });
await call('/v1/users', { token: su.token, tenant: su.tenant.slug, body: { email: `demo-${sfx}@openpark.io`, roles: ['attendant'] } }); // becomes a member (local auth)
const b = await chromium.launch({ channel: 'chrome' });
async function session(email) {
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })).newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${WEB}/login`); await p.fill('input[name=email]', email); await p.fill('input[name=password]', 'correct-horse-battery'); await p.click('button.primary');
  await p.waitForURL(/dashboard/); p.errs = errs; return p;
}

// --- an admin (not a super admin) ---
let p = await session(`root-${sfx}@example.com`);
await p.goto(`${WEB}/t/${su.tenant.slug}/users`); await p.waitForSelector('.roles');
const labels = await p.$$eval('form .rolebox strong', (e) => e.map((x) => x.textContent.trim()));
ok(JSON.stringify(labels) === JSON.stringify(['Resident', 'Attendant', 'Supervisor', 'Admin']), `role checkboxes, least to most access, no Super Admin for an admin: ${labels.join(' / ')}`);
ok((await p.$$('form select[name=role]')).length === 0, 'no role dropdown any more');
await p.fill('form input[name=email]', `rosa-${sfx}@example.com`);
await p.check('#new-resident'); await p.check('#new-attendant'); // attendant is ticked by default; resident adds a unit picker
await p.selectOption('form select[name=unit]', 'U1');
await p.click('form button.primary'); await p.waitForSelector('.banner[role=status]');
ok((await p.locator('tr', { hasText: `rosa-${sfx}@example.com` }).innerText()).includes('Resident · Attendant'), 'a person can be added with several roles at once');
// Pending invitations only exist with external sign-in (Supabase); create one directly for this local-auth run.
execSync(`docker exec openpark-pg psql -U openpark -d openpark -c "insert into membership_invite (tenant_id, email, roles, unit_id) select t.id, 'invitee-${sfx}@example.com', array['resident','attendant'], u.id from tenant t join unit u on u.tenant_id = t.id and u.code = 'U1' where t.slug = '${su.tenant.slug}'"`, { stdio: 'ignore' });
await p.reload(); await p.waitForSelector('.roles');
ok((await p.locator('tr', { hasText: `invitee-${sfx}@example.com` }).innerText()).includes('Resident · Attendant'), 'a pending invitation lists its roles');

// pending invitation: edit and delete
const row = p.locator('tr', { hasText: `invitee-${sfx}@example.com` });
await row.getByRole('button', { name: 'Edit' }).click();
await p.check('#edit-supervisor'); await p.selectOption('section[aria-label] select', 'U2'); await p.getByRole('button', { name: 'Save' }).click();
await p.waitForFunction((t) => document.body.innerText.includes('Resident · Attendant · Supervisor'), null);
ok((await row.innerText()).includes('U2'), 'edited the pending invitation: added Supervisor and moved it to Unit 2');
await row.getByRole('button', { name: 'Remove' }).click();
await p.waitForFunction((e) => !document.body.innerText.includes(e), `invitee-${sfx}@example.com`);
ok(true, 'deleted the pending invitation');

// member: edit roles
const demo = p.locator('tr', { hasText: `demo-${sfx}@openpark.io` });
await demo.getByRole('button', { name: 'Edit' }).click();
await p.check('#edit-supervisor'); await p.getByRole('button', { name: 'Save' }).click();
await p.waitForFunction(() => document.body.innerText.includes('Attendant · Supervisor'));
ok(true, 'edited a member: Attendant + Supervisor');
ok((await p.$$('#edit-superadmin')).length === 0, 'an admin is not offered Super Admin');
ok(p.errs.length === 0, 'no page errors');
await p.context().close();

// --- a super admin ---
execSync(`docker exec openpark-pg psql -U openpark -d openpark -c "update app_user set is_superadmin = true where email = 'root-${sfx}@example.com'"`, { stdio: 'ignore' });
p = await session(`root-${sfx}@example.com`);
await p.goto(`${WEB}/t/${su.tenant.slug}/users`); await p.waitForSelector('.roles');
await p.locator('tr', { hasText: `demo-${sfx}@openpark.io` }).getByRole('button', { name: 'Edit' }).click();
ok((await p.$$('#edit-superadmin')).length === 1, 'a Super Admin can grant Super Admin');
const opts = await p.$$eval('select[aria-label="Property"] option', (o) => o.map((x) => x.value));
ok(opts.includes(su.tenant.slug) && opts.includes(other.tenant.slug), `property toggle lists ALL properties (${opts.length})`);
await p.selectOption('select[aria-label="Property"]', other.tenant.slug);
await p.waitForURL(new RegExp(other.tenant.slug)); 
ok(true, 'switching property enters that property');
ok(p.errs.length === 0, 'no page errors');

// A property with no units says so and links to Units instead of asking for one.
const empty = await mk('empty');
execSync(`docker exec openpark-pg psql -U openpark -d openpark -c "update app_user set is_superadmin = true where email = 'empty-${sfx}@example.com'"`, { stdio: 'ignore' });
const q = await session(`empty-${sfx}@example.com`);
await q.goto(`${WEB}/t/${empty.tenant.slug}/users`); await q.waitForSelector('.roles');
await q.check('#new-resident');
ok(await q.locator('form .banner a[href$="/units"]').isVisible(), 'no units yet: the form links to Units instead of asking for a unit');
// Super Admin picks another property (with its own units) for a new person.
await q.selectOption('form select:not([name])', su.tenant.slug);
await q.waitForSelector('form select[name=unit] option[value=U1]', { state: 'attached' });
const unitOpts = await q.$$eval('form select[name=unit] option', (o) => o.map((x) => x.value).filter(Boolean));
ok(unitOpts.includes('U1') && unitOpts.includes('U2'), `choosing another property offers that property's units (${unitOpts.join(', ')})`);
await b.close();
