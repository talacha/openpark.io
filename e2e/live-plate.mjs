// The camera reads a plate on-device and submits by itself. Uses Chrome's fake camera fed with a plate image (arg 2: .y4m).
// Needs api :3000 (TRIAL_SIGNUP=true) and web :5173 (npm run dev fetches the models first).
import { chromium } from 'playwright-core';
const API = 'http://localhost:3000', WEB = process.env.WEB ?? 'http://localhost:5173';
const sfx = Math.random().toString(36).slice(2, 8);
const call = (path, { token, tenant, method = 'POST', body } = {}) => fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenant ? { 'x-tenant': tenant } : {}) }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const su = await call('/v1/signup', { body: { email: `live-${sfx}@example.com`, password: 'correct-horse-battery', organisation: `Live ${sfx}`, country: 'BR' } });
await call('/v1/me/profile', { method: 'PATCH', token: su.token, tenant: su.tenant.slug, body: { locale: 'en' } });
const b = await chromium.launch({ channel: 'chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${process.argv[3]}`] });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US', permissions: ['camera'] });
const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto(`${WEB}/login`); await p.fill('input[name=email]', `live-${sfx}@example.com`); await p.fill('input[name=password]', 'correct-horse-battery'); await p.click('button.primary');
await p.waitForURL(/dashboard/); await p.goto(`${WEB}/t/${su.tenant.slug}/a/checkin`);
const t0 = Date.now();
await p.waitForURL(/checkin\/(confirm|review)/, { timeout: 40000 }).catch(async (e) => { console.log('STUCK:', (await p.locator('.att').innerText()).replace(/\n/g, ' | ')); console.log(errs.join('\n')); await p.screenshot({ path: process.argv[2] + '/live-stuck.png' }); throw e; });
console.log(`✓ the camera read the plate and moved on by itself after ${((Date.now() - t0) / 1000).toFixed(1)}s → ${p.url().split('/').pop()}`);
const shown = await p.locator('.platebox, .att').first().innerText();
if (!/BRA2E19|BRA 2E19|BRA-2E19/.test(shown.replace(/\s/g, '') ) && !/BRA/.test(shown)) throw new Error('plate not shown: ' + shown);
console.log('✓ plate shown:', shown.replace(/\n/g, ' ').slice(0, 80));
if (errs.length) { console.log(errs.join('\n')); process.exitCode = 1; } else console.log('✓ no console errors');
await p.screenshot({ path: process.argv[2] + '/live-plate.png' });
await b.close();
