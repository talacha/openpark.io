// Closed preview (TRIAL_SIGNUP off, PUBLIC_TRIAL_SIGNUP unset): no way to start a trial anywhere in the UI.
import { chromium } from 'playwright-core';
const b = await chromium.launch({ channel: 'chrome' }); const p = await (await b.newContext({ viewport: { width: 1000, height: 800 }, locale: 'en-US' })).newPage();
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));

await p.goto('http://localhost:5173/signup');
await p.waitForSelector('text=Closed preview');
if (await p.locator('input[name=org]').count()) throw new Error('organisation field must not exist while closed');
console.log('✓ app /signup shows the closed-preview notice (no form)');
await p.screenshot({ path: process.argv[2] + '/c-app-signup.png' });

await p.goto('http://localhost:5173/login');
await p.waitForSelector('input[name=email]');
if (await p.locator('a[href="/signup"]').count()) throw new Error('login must not advertise signup while closed');
console.log('✓ app /login has no "start free trial" link');

await p.goto('http://localhost:4321/');
await p.waitForSelector('text=Closed preview');
if (await p.locator('form#signup').count() || (await p.textContent('body')).includes('Try it free')) throw new Error('marketing must not offer a trial while closed');
console.log('✓ marketing home: trial form and "Try it free" are gone; sign-in link shown');
await p.screenshot({ path: process.argv[2] + '/c-marketing.png' });
await p.goto('http://localhost:4321/pricing/');
if ((await p.locator('a[href$="#trial"]').count())) throw new Error('pricing must not link to a trial form');
await p.goto('http://localhost:4321/es-MX/');
await p.waitForSelector('text=Vista previa cerrada');
console.log('✓ localized (es-MX) closed notice');
await b.close();
if (errs.length) { console.error(errs); process.exit(1); }
