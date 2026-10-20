import pg from 'pg';

export type Db = pg.PoolClient;

export class Database {
  readonly pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 10 });
  }

  /** Run `fn` in a transaction with the tenant set, so RLS scopes every statement. */
  async withTenant<T>(tenantId: string, fn: (db: Db) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('begin');
      await db.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      const out = await fn(db);
      await db.query('commit');
      return out;
    } catch (e) {
      await db.query('rollback').catch(() => {});
      throw e;
    } finally {
      db.release();
    }
  }

  /** No tenant context: only for the security-definer lookups and global tables. */
  async raw<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      return await fn(db);
    } finally {
      db.release();
    }
  }

  close() { return this.pool.end(); }
}

export async function emit(db: Db, tenantId: string, type: string, data: unknown) {
  await db.query('select emit_event($1, $2, $3::jsonb)', [tenantId, type, JSON.stringify(data)]);
}

export async function audit(db: Db, tenantId: string, actorId: string | null, action: string, entity: string, before: unknown, after: unknown) {
  await db.query(
    'insert into audit_event (tenant_id, actor_id, action, entity, before, after) values ($1,$2,$3,$4,$5,$6)',
    [tenantId, actorId, action, entity, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after)],
  );
}
