import pg from 'pg';
import { migrate } from '../src/migrate.js';

const ADMIN = process.env.TEST_ADMIN_URL ?? 'postgres://openpark:openpark@localhost:54329/postgres';

/** Fresh database per run so RLS and grants are tested from the real migrations. */
export default async function setup() {
  const name = `openpark_test_${Date.now()}`;
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  await c.query(`create database ${name}`);
  await c.end();
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
