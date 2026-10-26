import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./', import.meta.url));
const SLOT_TYPES = {
  standard: { prefix: '', label: { en: 'Standard', 'es-MX': 'Estándar' } },
  accessible: { prefix: 'A', label: { en: 'Accessible', 'es-MX': 'Accesible' } },
  moto: { prefix: 'M', label: { en: 'Motorcycle', 'es-MX': 'Motocicleta' } },
  ev: { prefix: 'E', label: { en: 'EV charging', 'es-MX': 'Carga eléctrica' } },
};
const PROPERTY_TYPES = new Set(['residential', 'office', 'retail', 'mixed']);
const ROLES = new Set(['resident', 'attendant', 'supervisor', 'admin']);
const slugify = (value) => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'property';
const code = (value, label) => {
  const result = String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, '-');
  if (!result) throw new Error(`${label} must contain letters or numbers`);
  return result;
};
const text = (value, label) => {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
};
const integer = (value, label, minimum = 0) => {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${label} must be an integer of at least ${minimum}`);
  return value;
};
const email = (value) => {
  const result = text(value, 'email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new Error(`Invalid email: ${result}`);
  return result;
};
const write = (out, name, value) => writeFileSync(resolve(out, name), `${JSON.stringify(value, null, 2)}\n`);

export function generate(answers, out) {
  const property = answers.property ?? {};
  if (!PROPERTY_TYPES.has(property.type)) throw new Error(`property.type must be one of ${[...PROPERTY_TYPES].join(', ')}`);
  const name = text(property.name, 'property.name');
  const country = code(property.country, 'property.country');
  if (country.length !== 2) throw new Error('property.country must be a two-letter country code');
  const timezone = text(property.timezone, 'property.timezone');
  const owner = property.owner ?? {};
  const ownerEmail = email(owner.email);
  const ownerName = text(owner.name, 'property.owner.name');
  const tenant = slugify(name);
  if (!Array.isArray(answers.buildings) || !answers.buildings.length) throw new Error('At least one building is required');

  const unitCodes = new Set();
  const siteCodes = new Set();
  const units = [];
  const sites = answers.buildings.map((building) => {
    const siteCode = code(building.siteCode, 'building.siteCode');
    if (siteCodes.has(siteCode)) throw new Error(`Duplicate site code: ${siteCode}`);
    siteCodes.add(siteCode);
    const siteName = text(building.name, `${siteCode} name`);
    if (!Array.isArray(building.floors) || !building.floors.length) throw new Error(`${siteCode} needs at least one floor`);
    const floorCodes = new Set();
    const zones = building.floors.map((floor) => {
      const floorCode = code(floor.code, `${siteCode} floor code`);
      if (floorCodes.has(floorCode)) throw new Error(`Duplicate floor ${floorCode} in ${siteCode}`);
      floorCodes.add(floorCode);
      const floorName = text(floor.name, `${siteCode}/${floorCode} name`);
      const level = integer(floor.level, `${siteCode}/${floorCode} level`, -20);
      const slots = [];
      for (const [type, config] of Object.entries(SLOT_TYPES)) {
        const count = integer(floor.slots?.[type] ?? 0, `${siteCode}/${floorCode} ${type} slots`);
        for (let n = 1; n <= count; n++) slots.push({ code: `${floorCode}-${config.prefix}${String(n).padStart(3, '0')}`, type });
      }
      if (!slots.length) throw new Error(`${siteCode}/${floorCode} must have at least one slot`);
      return { code: floorCode, name: { en: floorName, 'es-MX': floorName }, level, slots };
    });

    const allocation = building.units ?? {};
    const prefix = code(allocation.prefix, `${siteCode} unit prefix`);
    const start = integer(allocation.start, `${siteCode} first unit number`, 1);
    const count = integer(allocation.count, `${siteCode} unit count`, 1);
    for (let n = 0; n < count; n++) {
      const unitCode = `${prefix}${start + n}`;
      if (unitCodes.has(unitCode)) throw new Error(`Duplicate unit code: ${unitCode}`);
      unitCodes.add(unitCode);
      units.push({ code: unitCode, name: `${siteName} - ${start + n}`, site: siteCode, residents: [] });
    }
    return { code: siteCode, name: siteName, timezone, zones };
  });

  const staff = (answers.staff ?? []).map((person) => {
    const roles = [...new Set(person.roles ?? [])];
    if (!roles.length || roles.some((role) => !ROLES.has(role))) throw new Error(`Invalid roles for ${person.email}`);
    const user = { email: email(person.email), name: text(person.name, 'staff.name'), roles };
    if (person.unit) user.unit = code(person.unit, 'staff.unit');
    user.unitVerified = person.unitVerified !== false;
    return user;
  });
  for (const person of staff) if (person.unit && !unitCodes.has(person.unit)) throw new Error(`Unknown unit ${person.unit} for ${person.email}`);

  mkdirSync(out, { recursive: true });
  mkdirSync(resolve(out, 'supabase'), { recursive: true });
  const exportedAt = new Date().toISOString();
  write(out, 'inventory.json', {
    $schema: 'https://schemas.openpark.io/inventory/v1.json', schemaVersion: 1, tenant, exportedAt,
    slotTypes: Object.entries(SLOT_TYPES).map(([code, config]) => ({ code, label: config.label })), sites,
  });
  write(out, 'units.json', { $schema: 'https://schemas.openpark.io/units/v1.json', schemaVersion: 1, tenant, exportedAt, units });
  write(out, 'users.json', { $schema: 'https://schemas.openpark.io/users/v1.json', schemaVersion: 1, tenant, exportedAt, users: staff });
  write(out, 'community.json', {
    $schema: 'https://schemas.openpark.io/community/v1.json', schemaVersion: 1, tenant, exportedAt,
    communities: [{ slug: tenant, name }],
  });
  write(out, 'tenant.json', { slug: tenant, property: { type: property.type, name, country, timezone, owner: { email: ownerEmail, name: ownerName } } });
  writeFileSync(resolve(out, 'supabase', 'config.toml'), `project_id = "openpark-single-tenant"\n\n[auth]\nsite_url = "http://localhost:8080"\nadditional_redirect_urls = ["http://localhost:8080"]\n\n[auth.email]\nenable_signup = true\nenable_confirmations = false\n`);
  writeFileSync(resolve(out, 'compose.yaml'), COMPOSE);
  return { tenant, sites: sites.length, units: units.length, slots: sites.reduce((sum, site) => sum + site.zones.reduce((n, zone) => n + zone.slots.length, 0), 0), staff: staff.length };
}

const COMPOSE = `name: openpark-single-tenant

networks:
  default:
    name: supabase_network_openpark-single-tenant
    external: true

x-api-env: &api-env
  DATABASE_URL: postgres://openpark_app:\${OPENPARK_APP_PASSWORD}@supabase_db_openpark-single-tenant:5432/postgres
  ADMIN_DATABASE_URL: postgres://postgres:\${POSTGRES_PASSWORD}@supabase_db_openpark-single-tenant:5432/postgres
  OPENPARK_APP_PASSWORD: \${OPENPARK_APP_PASSWORD}
  JWT_SECRET: \${JWT_SECRET}
  SUPABASE_URL: http://supabase_kong_openpark-single-tenant:8000
  SUPABASE_JWT_SECRET: \${SUPABASE_JWT_SECRET}
  STORAGE_DIR: /data
  ALPR_URL: http://alpr:8000
  TRIAL_SIGNUP: "true"
  LOCAL_AUTH: "false"
  WEBHOOKS_ALLOW_PRIVATE: "true"

services:
  migrate:
    build: { context: ../../.., dockerfile: deploy/Dockerfile.api }
    command: ["node", "dist/migrate.js"]
    environment: *api-env
    restart: "no"

  api:
    build: { context: ../../.., dockerfile: deploy/Dockerfile.api }
    environment: *api-env
    volumes: [objects:/data]
    depends_on: { migrate: { condition: service_completed_successfully } }
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      retries: 20

  web:
    build:
      context: ../../..
      dockerfile: deploy/Dockerfile.web
      args:
        VITE_SUPABASE_URL: http://localhost:8000
        VITE_SUPABASE_PUBLISHABLE_KEY: \${VITE_SUPABASE_PUBLISHABLE_KEY}
    ports: ["\${WEB_PORT:-8080}:80"]
    depends_on: { api: { condition: service_healthy } }

  alpr:
    build: { context: ../../.., dockerfile: deploy/Dockerfile.alpr-single-tenant }
    environment:
      VLM_URL: http://vlm:11434/v1
      VLM_MODEL: \${VLM_MODEL:-qwen3.5:4b}

  vlm:
    image: ollama/ollama:latest
    volumes: [ollama:/root/.ollama]

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      retries: 10

volumes: { objects: {}, ollama: {} }
`;

const args = process.argv.slice(2);
if (args.length) {
  const outFlag = args.indexOf('--out');
  const answersPath = args[0];
  const out = resolve(outFlag >= 0 ? args[outFlag + 1] : resolve(ROOT, 'generated'));
  if (existsSync(out) && !args.includes('--force')) throw new Error(`${out} already exists; use --force to replace it`);
  const answers = JSON.parse(readFileSync(resolve(answersPath), 'utf8'));
  const summary = generate(answers, out);
  console.log(`Generated ${summary.sites} sites, ${summary.units} units, ${summary.slots} slots, and ${summary.staff} staff accounts for ${summary.tenant}.`);
}
