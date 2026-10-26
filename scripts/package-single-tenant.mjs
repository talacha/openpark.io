import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(root, 'dist/openpark-single-tenant');
const archive = resolve(root, 'dist/openpark-single-tenant.tar.gz');
const sources = [
  'apps/api', 'apps/web', 'packages/core', 'packages/ui', 'packages/single-tenant',
  'services/alpr', 'registry', 'schemas', 'deploy', 'skills/openpark-single-tenant',
  'scripts/package-single-tenant.mjs', 'e2e/package.json', 'compose.yaml',
  'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json', '.dockerignore',
];
const excluded = new Set(['node_modules', 'dist', 'generated', 'test', 'tests', '.git', '.astro', '.venv', '__pycache__', 'models', 'ort', '.pytest_cache', 'openpark_alpr.egg-info']);
const copy = (source, destination) => cpSync(source, destination, {
  recursive: true,
  filter: (path) => {
    const name = basename(path);
    if (name.startsWith('.env') || name.startsWith('._')) return false;
    return !excluded.has(name);
  },
});
function cleanMetadata(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name.startsWith('._') || entry.name === '.DS_Store') rmSync(path, { recursive: true, force: true });
    else if (entry.isDirectory()) cleanMetadata(path);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const source of sources) {
  const from = resolve(root, source);
  if (!existsSync(from)) throw new Error(`Required runtime source is missing: ${source}`);
  const destination = join(out, source);
  mkdirSync(dirname(destination), { recursive: true });
  copy(from, destination);
}
cpSync(resolve(root, 'packages/single-tenant/README.md'), join(out, 'README.md'));
cleanMetadata(out);
execFileSync('tar', ['-czf', archive, '-C', resolve(root, 'dist'), 'openpark-single-tenant'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
console.log(`Packaged ${out} and ${archive}`);
