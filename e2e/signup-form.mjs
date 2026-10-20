// Needs the API up with TRIAL_SIGNUP=true. The hosting 404 is simulated in the browser. Signup form: password reveal, translation, and a readable error when the API is unreachable/non-JSON.
import { chromium } from 'playwright-core';
const b = await chromium.launch({ channel: 'chrome' });
const ctx = await b.newContext({ viewport: { width: 1000, height: 800 }, locale: 'es-419' });
const p = await ctx.newPage();
const pageErrors = [];
p.on('pageerror', (e) => pageErrors.push(String(e)));

await p.goto('http://localhost:5173/signup');
const h1 = await p.textContent('h1');
if (!/prueba gratis/i.test(h1)) throw new Error(`browser locale es-419 should render Spanish, got "${h1}"`);
console.log('✓ es-419 browser renders Spanish:', h1);

const pwd = p.locator('input[name=password]');
await pwd.fill('secreto-largo-123');
if ((await pwd.getAttribute('type')) !== 'password') throw new Error('should start hidden');
await p.click('.pwd-toggle');
if ((await pwd.getAttribute('type')) !== 'text') throw new Error('should reveal');
console.log('✓ reveal toggle:', await p.getAttribute('.pwd-toggle', 'aria-label'));
await p.click('.pwd-toggle');
if ((await pwd.getAttribute('type')) !== 'password') throw new Error('should hide again');

await p.selectOption('select.langpick', 'de');
console.log('✓ switched to German:', (await p.textContent('h1')), '|', await p.getAttribute('.pwd-toggle', 'aria-label'));
await p.selectOption('select.langpick', 'ar');
if ((await p.getAttribute('html', 'dir')) !== 'rtl') throw new Error('Arabic should be rtl');
await p.screenshot({ path: process.argv[2] + '/s-ar.png' });
await p.selectOption('select.langpick', 'es-MX');

// A hosting/proxy 404 with a plain-text body (what app.openpark.io returned before the /v1 proxy existed).
await p.route('**/v1/signup', (r) => r.fulfill({ status: 404, contentType: 'text/plain', body: 'The page could not be found' }));
await p.fill('input[name=org]', 'Org Prueba');
await p.fill('input[name=email]', 'x@example.com');
await p.click('button.primary');
await p.waitForSelector('.banner.bad');
const msg = (await p.textContent('.banner.bad')).trim();
if (/SyntaxError|not valid JSON/i.test(msg)) throw new Error(`raw parse error leaked: ${msg}`);
console.log('✓ non-JSON hosting error shows a readable message:', JSON.stringify(msg.slice(0, 80)));
await p.screenshot({ path: process.argv[2] + '/s-es-error.png' });

// Marketing form
await p.goto('http://localhost:4321/fr/');
await p.fill('input[name=password]', 'motdepasse-12345');
await p.click('#pwd-toggle');
if ((await p.getAttribute('input[name=password]', 'type')) !== 'text') throw new Error('marketing reveal failed');
console.log('✓ marketing reveal (fr):', await p.textContent('#pwd-toggle'));
await b.close();
if (pageErrors.length) { console.error(pageErrors); process.exit(1); }
