// Marketing site -> app hand-off. Needs the API (:3000), app (:5173) and marketing dev server (:4321).
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const shots = process.argv[2] ?? './shots';
mkdirSync(shots, { recursive: true });
const suffix = Math.random().toString(36).slice(2, 8);
const browser = await chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()); });

await page.goto('http://localhost:4321/');
await page.screenshot({ path: `${shots}/m1-landing.png` });
await page.fill('input[name=organisation]', `Marketing ${suffix}`);
await page.selectOption('select[name=country]', 'US');
await page.fill('input[name=email]', `visitor-${suffix}@example.com`);
await page.fill('input[name=password]', 'correct-horse-battery');
await page.click('form#signup button[type=submit]');
await page.waitForURL(/localhost:5173\/t\/.+\/dashboard/, { timeout: 15000 });
await page.waitForFunction(() => document.querySelector('.tile .value')?.textContent?.trim() === '52');
if (page.url().includes('token=')) throw new Error('token must be removed from the address bar');
console.log('✓ landing signup -> app dashboard with a seeded tenant; fragment cleaned:', page.url());

await page.goto('http://localhost:4321/ar/');
if ((await page.getAttribute('html', 'dir')) !== 'rtl') throw new Error('Arabic landing must be rtl');
await page.screenshot({ path: `${shots}/m2-landing-ar.png` });
await page.setViewportSize({ width: 390, height: 844 });
await page.goto('http://localhost:4321/es-MX/');
await page.screenshot({ path: `${shots}/m3-landing-mobile.png` });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
if (overflow > 0) throw new Error(`mobile landing overflows horizontally by ${overflow}px`);
console.log('✓ Arabic renders rtl; mobile landing has no horizontal overflow');

await browser.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('✓ no console errors');
