// Drives the real UI against a running API (:3000) and web dev server (:5173).
// Usage: node smoke.mjs [screenshotDir]   (uses installed Google Chrome)
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const shots = process.argv[2] ?? './shots';
mkdirSync(shots, { recursive: true });
const suffix = Math.random().toString(36).slice(2, 8);
const log = (m) => console.log(`✓ ${m}`);

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()); });

// Signup -> dashboard with the seeded demo site
await page.goto(`${WEB}/signup`);
await page.fill('input[name=name]', 'Rosa');
await page.fill('input[name=org]', `Smoke ${suffix}`);
await page.selectOption('select[name=country]', 'MX');
await page.fill('input[name=email]', `rosa-${suffix}@example.com`);
await page.fill('input[name=password]', 'correct-horse-battery');
await page.click('button.primary');
await page.waitForURL(/\/dashboard/);
await page.waitForSelector('.tile .value');
// Mexico defaults the UI to es-MX (checked below); the rest of the run uses English labels.
if (!(await page.textContent('h1')).includes('Ocupación')) throw new Error('country should default the UI to Spanish');
await page.waitForFunction(() => document.querySelector('.tile .value')?.textContent?.trim() === '52');
log('signup lands on the dashboard with 52 free slots, UI defaulted to es-MX');
const zone = await page.textContent('tbody tr td');
if (!zone.includes('Sótano')) throw new Error(`zone label should be localized, got ${zone}`);
log(`zone label localized: ${zone}`);
await page.selectOption('aside select[aria-label=Language]', 'en');
await page.screenshot({ path: `${shots}/01-dashboard.png` });

// Attendant: keypad check-in
await page.click('text=Attendant view');
await page.waitForURL(/\/a$/);
await page.click('.tabbar >> text=Check in');
for (const c of 'ABC123') await page.click(`.keypad button[aria-label="${c}"]`);
await page.screenshot({ path: `${shots}/02-keypad.png` });
await page.click('text=Next');
await page.waitForSelector('text=Confirm check-in');
await page.screenshot({ path: `${shots}/03-confirm.png` });
await page.click('text=Confirm check-in');
await page.waitForSelector('.kv dd.num');
const ticket = (await page.textContent('.kv dd.num')).trim();
log(`check-in issued ticket ${ticket}`);
await page.screenshot({ path: `${shots}/04-ticket.png` });
await page.click('text=Done');

// Check-out by ticket
await page.click('.tabbar >> text=Check out');
await page.fill('input[dir=ltr] >> nth=0', ticket);
await page.click('text=Find car');
await page.waitForSelector('.feetotal');
log(`check-out preview fee: ${(await page.textContent('.feetotal')).trim()}`);
await page.screenshot({ path: `${shots}/05-checkout.png` });
await page.click('text=Take payment');
await page.waitForSelector('text=/Receipt/');
log('check-out completed with receipt');
await page.click('text=Done');

// Admin: sessions log + timeline, slots, inventory export, rates
await page.goto(`${WEB}/`);
await page.waitForURL(/dashboard/);
await page.click('a.nav:has-text("Sessions")');
await page.click('tbody tr.click >> nth=0');
await page.waitForSelector('.timeline li');
const events = await page.$$eval('.timeline li strong', (n) => n.map((x) => x.textContent));
if (events.join() !== 'check_in,slot_assigned,check_out,payment') throw new Error(`timeline was ${events}`);
log(`session timeline: ${events.join(' → ')}`);
await page.screenshot({ path: `${shots}/06-sessions.png` });

await page.click('a.nav:has-text("Rate plans")');
await page.click('text=Quote');
await page.waitForSelector('.feetotal');
await page.screenshot({ path: `${shots}/07-rates.png` });

await page.click('a.nav:has-text("Slots")');
await page.waitForSelector('.slot');
await page.screenshot({ path: `${shots}/08-slots.png` });

await page.click('a.nav:has-text("Import / export")');
await page.fill('textarea', '{\n  "schemaVersion": 1,\n  "sites": [,]\n}');
await page.click('text=Validate and preview');
await page.waitForSelector('.banner.bad');
errors.length = 0; // the 400 above is the point of this step
log(`bad JSON reported: ${(await page.textContent('.banner.bad')).trim().slice(0, 80)}`);
await page.screenshot({ path: `${shots}/09-inventory-error.png` });

// Localization: Arabic flips to right-to-left; pseudo-locale renders
await page.selectOption('aside select[aria-label=Language]', 'ar');
if ((await page.getAttribute('html', 'dir')) !== 'rtl') throw new Error('html[dir] should be rtl for Arabic');
await page.click('a.nav >> nth=0');
await page.waitForSelector('.tile .value');
await page.screenshot({ path: `${shots}/10-dashboard-ar.png` });
log('Arabic renders right-to-left');
await page.selectOption('aside select[aria-label=Language]', 'en-XA');
await page.screenshot({ path: `${shots}/11-pseudo.png` });

// Phone viewport, attendant home
await page.setViewportSize({ width: 390, height: 844 });
await page.selectOption('aside select[aria-label=Language]', 'es-MX').catch(() => {});
await page.goto(`${WEB}/`);
await page.waitForSelector('.tile .value');
await page.screenshot({ path: `${shots}/12-mobile-dashboard.png` });

await browser.close();
if (errors.length) { console.error('Browser errors:\n' + errors.join('\n')); process.exit(1); }
log('no console errors');
