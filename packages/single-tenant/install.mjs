import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./', import.meta.url));
const GENERATED = resolve(ROOT, 'generated');
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'pipe', ...options });
const compose = (args, env) => execFileSync('docker', ['compose', '-f', resolve(GENERATED, 'compose.yaml'), ...args], { stdio: 'inherit', env: { ...process.env, ...env } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(url, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch (error) { lastError = error; }
    await sleep(3000);
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? `: ${lastError.message}` : ''}`);
}

function statusValue(status, ...names) {
  for (const name of names) {
    const entry = Object.entries(status).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (entry?.[1]) return entry[1];
  }
  return '';
}

async function api(path, { token, tenant, method = 'POST', body } = {}) {
  const response = await fetch(`http://localhost:8080${path}`, {
    method,
    headers: {
      'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-tenant': tenant,
      ...(method === 'GET' ? {} : { 'idempotency-key': crypto.randomUUID() }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 500)}`);
  return data;
}

async function applyImport(path, doc, auth) {
  const preview = await api(path, { ...auth, body: { text: JSON.stringify(doc) } });
  if (!preview?.job) throw new Error(`Import preview did not return a job: ${path}`);
  const base = path.split('?')[0];
  await api(`${base}/${preview.job}/apply`, { ...auth, body: {} });
}

const tenantDoc = JSON.parse(readFileSync(resolve(GENERATED, 'tenant.json'), 'utf8'));
const password = process.env.OPENPARK_ADMIN_PASSWORD;
if (!password || password.length < 10) throw new Error('Set OPENPARK_ADMIN_PASSWORD to at least 10 characters before installing');

console.log('Starting Supabase locally…');
run('supabase', ['start'], { cwd: resolve(GENERATED, 'supabase') });
const status = JSON.parse(run('supabase', ['status', '-o', 'json'], { cwd: resolve(GENERATED, 'supabase') }).toString());
const publishableKey = statusValue(status, 'ANON_KEY', 'publishable_key', 'publishableKey');
const supabaseJwtSecret = statusValue(status, 'JWT_SECRET', 'jwtSecret');
const supabaseUrl = statusValue(status, 'API_URL', 'apiUrl');
if (!publishableKey || !supabaseUrl) throw new Error('Supabase did not return its API URL and publishable key');

const env = {
  SUPABASE_BROWSER_URL: supabaseUrl,
  POSTGRES_PASSWORD: 'postgres',
  OPENPARK_APP_PASSWORD: randomBytes(24).toString('base64url'),
  JWT_SECRET: randomBytes(48).toString('base64url'),
  SUPABASE_JWT_SECRET: supabaseJwtSecret,
  VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey,
  TRIAL_SIGNUP: 'true',
  WEB_PORT: process.env.WEB_PORT ?? '8080',
  VLM_MODEL: process.env.VLM_MODEL ?? 'qwen3.5:4b',
};

console.log('Building OpenPark and the embedded plate reader…');
compose(['up', '-d', '--build'], env);
await waitForHealth('http://localhost:8080/healthz');

console.log('Creating the tenant and applying property configuration…');
const serviceKey = statusValue(status, 'SECRET_KEY', 'SERVICE_ROLE_KEY');
const authRequest = async (path, body, { admin = false, method = 'POST' } = {}) => {
  const response = await fetch(`${supabaseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(admin ? { apikey: serviceKey, authorization: `Bearer ${serviceKey}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Supabase Auth ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
};
const credentials = { email: tenantDoc.property.owner.email, password };
const login = () => authRequest('/auth/v1/token?grant_type=password', credentials);
const resetExistingAdmin = async () => {
  if (!serviceKey) throw new Error('Supabase did not return its admin key');
  const directory = await authRequest('/auth/v1/admin/users?page=1&per_page=1000', undefined, { admin: true, method: 'GET' });
  const existing = directory.users?.find((user) => user.email?.toLowerCase() === credentials.email.toLowerCase());
  if (!existing) throw new Error(`Supabase admin account not found: ${credentials.email}`);
  await authRequest(`/auth/v1/admin/users/${existing.id}`, { password, email_confirm: true }, { admin: true, method: 'PUT' });
  return login();
};
let external;
try {
  external = await authRequest('/auth/v1/signup', {
    ...credentials, data: { full_name: tenantDoc.property.owner.name },
  });
} catch {
  external = null;
}
if (!external?.access_token) external = await resetExistingAdmin();
let signup = { tenant: { slug: tenantDoc.slug, name: tenantDoc.property.name } };
try {
  await api('/v1/me', { token: external.access_token, tenant: tenantDoc.slug, method: 'GET' });
} catch {
  signup = await api('/v1/signup', {
    token: external.access_token, tenant: '',
    body: {
      organisation: tenantDoc.property.name,
      country: tenantDoc.property.country,
      name: tenantDoc.property.owner.name,
      slug: tenantDoc.slug,
    },
  });
}
const auth = { token: external.access_token, tenant: signup.tenant.slug };
const sites = await api('/v1/sites', { ...auth, method: 'GET' });
if (sites.some((site) => site.code === 'DEMO-01' && site.name === 'Demo Site')) {
  await api('/v1/sites/DEMO-01', { ...auth, method: 'DELETE', body: {} });
}
const withTenant = (name) => ({ ...JSON.parse(readFileSync(resolve(GENERATED, name), 'utf8')), tenant: signup.tenant.slug });
await applyImport('/v1/inventory/import?mode=replace&dryRun=false', withTenant('inventory.json'), auth);
await applyImport('/v1/units/import?mode=replace&dryRun=false', withTenant('units.json'), auth);
await applyImport('/v1/users/import?dryRun=false', withTenant('users.json'), auth);
await applyImport('/v1/community/import?dryRun=false', withTenant('community.json'), auth);

console.log('Closing self-service signup…');
compose(['up', '-d', '--no-deps', '--force-recreate', 'api'], { ...env, TRIAL_SIGNUP: 'false' });
await waitForHealth('http://localhost:8080/healthz');
console.log(`Ready: ${signup.tenant.name} at http://localhost:${env.WEB_PORT}`);
console.log('Admin sign-in uses the email from tenant.json and OPENPARK_ADMIN_PASSWORD. Staff accounts were invited.');
