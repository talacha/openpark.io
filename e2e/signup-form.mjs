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
const show = p.getByRole('checkbox', { name: 'Mostrar contraseña' });
await show.check();
if ((await pwd.getAttribute('type')) !== 'text') throw new Error('should reveal');
console.log('✓ "Show password" checkbox reveals the field:', await p.textContent('.showpw'));
const eye = p.locator('.pwd-eye');
if ((await eye.getAttribute('aria-pressed')) !== 'true') throw new Error('eye must reflect the checkbox (shown)');
await show.uncheck();
if ((await pwd.getAttribute('type')) !== 'password' || (await eye.getAttribute('aria-pressed')) !== 'false') throw new Error('unchecking must hide and reset the eye');
await eye.click();
if ((await pwd.getAttribute('type')) !== 'text' || !(await show.isChecked())) throw new Error('clicking the eye must reveal and tick the checkbox');
await eye.click();
if ((await pwd.getAttribute('type')) !== 'password' || (await show.isChecked())) throw new Error('clicking the eye again must hide and untick the checkbox');
console.log('✓ eye button and checkbox share one state, both directions');

await p.selectOption('select.langpick', 'de');
console.log('✓ switched to German:', (await p.textContent('h1')), '|', (await p.textContent('.showpw')).trim());
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
await p.click('#pw-eye');
if ((await p.getAttribute('input[name=password]', 'type')) !== 'text' || !(await p.isChecked('#pw-show'))) throw new Error('marketing: eye must reveal and tick the checkbox');
if (await p.locator('#eye-off').isHidden()) throw new Error('marketing: slashed eye should be showing');
await p.uncheck('#pw-show');
if ((await p.getAttribute('input[name=password]', 'type')) !== 'password' || await p.locator('#eye-on').isHidden()) throw new Error('marketing: checkbox must hide and restore the open eye');
await p.check('#pw-show');
console.log('✓ marketing "show password" checkbox (fr):', (await p.textContent('.showpw')).trim());
await b.close();
if (pageErrors.length) { console.error(pageErrors); process.exit(1); }
