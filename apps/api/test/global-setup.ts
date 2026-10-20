import pg from 'pg';
import { migrate } from '../src/migrate.js';

const ADMIN = process.env.TEST_ADMIN_URL ?? 'postgres://openpark:openpark@localhost:54329/postgres';

/** Fresh database per run so RLS and grants are tested from the real migrations. */
export default async function setup() {
  const name = `openpark_test_${Date.now()}`;
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  // Mimic Supabase: Data API roles that are granted every table and function by default.
  await c.query(`do $$ begin
    if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$`);
  await c.query(`create database ${name}`);
  await c.end();
  const pre = new pg.Client({ connectionString: `${ADMIN.replace(/\/postgres$/, '')}/${name}` });
  await pre.connect();
  await pre.query(`alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
    grant usage on schema public to anon, authenticated;`);
  await pre.end();
  const base = ADMIN.replace(/\/postgres$/, '');
  process.env.ADMIN_DATABASE_URL = `${base}/${name}`;
  const u = new URL(ADMIN);
  process.env.DATABASE_URL = `postgres://openpark_app:openpark_app@${u.host}/${name}`;
  await migrate(process.env.ADMIN_DATABASE_URL);
  return async () => {
    const d = new pg.Client({ connectionString: ADMIN });
    await d.connect();
    await d.query(`drop database ${name} with (force)`);
    await d.end();
  };
}
