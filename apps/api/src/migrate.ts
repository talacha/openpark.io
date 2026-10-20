import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from './config.js';

const dir = fileURLToPath(new URL('../migrations/', import.meta.url));

export async function migrate(adminUrl: string, appPassword?: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('create table if not exists schema_migration (name text primary key, at timestamptz not null default now())');
    const done = new Set((await client.query('select name from schema_migration')).rows.map((r) => r.name));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await client.query('begin');
      try {
        await client.query(readFileSync(dir + file, 'utf8'));
        await client.query('insert into schema_migration (name) values ($1)', [file]);
        await client.query('commit');
        applied.push(file);
      } catch (e) {
        await client.query('rollback');
        throw new Error(`migration ${file} failed: ${(e as Error).message}`);
      }
    }
    if (appPassword) await client.query(`alter role openpark_app password ${client.escapeLiteral(appPassword)}`);
  } finally {
    await client.end();
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cfg = loadConfig();
  migrate(cfg.ADMIN_DATABASE_URL, cfg.OPENPARK_APP_PASSWORD).then((a) => {
    console.log(a.length ? `applied: ${a.join(', ')}` : 'up to date');
  }, (e) => { console.error(e); process.exit(1); });
}
