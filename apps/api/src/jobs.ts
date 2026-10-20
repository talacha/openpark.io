import { createHmac } from 'node:crypto';
import PgBoss from 'pg-boss';
import pg from 'pg';
import type { Config } from './config.js';
import type { Database } from './db.js';
import type { App } from './server.js';

export type WebhookEvent = 'session.opened' | 'session.closed' | 'slot.changed' | 'read.needs_review';
interface WebhookJob { tenantId: string; event: WebhookEvent; payload: unknown; at: string }

/** pg-boss queue inside Postgres: webhook delivery with backoff and the retention purge. */
export class Jobs {
  private boss: PgBoss | null = null;
  private admin: pg.Pool | null = null;

  constructor(private cfg: Config, private db: Database, private log: { error: (e: unknown, m?: string) => void; info: (m: string) => void }) {}

  async start(app: App) {
    if (!this.cfg.JOBS_ENABLED) return;
    this.boss = new PgBoss(this.cfg.ADMIN_DATABASE_URL);
    this.boss.on('error', (e) => this.log.error(e, 'pg-boss error'));
    await this.boss.start();
    await this.boss.createQueue('webhook');
    await this.boss.createQueue('retention-purge');
    await this.boss.work<WebhookJob>('webhook', async (jobs) => {
      for (const j of jobs) await this.deliver(j.data);
    });
    await this.boss.schedule('retention-purge', '17 3 * * *');
    await this.boss.work('retention-purge', async () => { await this.purge(app); });
  }

  /** Queue a webhook fan-out for a tenant event. No-op when jobs are disabled. */
  async enqueue(tenantId: string, event: WebhookEvent, payload: unknown) {
    if (!this.boss) return;
    await this.boss.send('webhook', { tenantId, event, payload, at: new Date().toISOString() } satisfies WebhookJob,
      { retryLimit: 6, retryBackoff: true, retryDelay: 5 });
  }

  private async deliver(job: WebhookJob) {
    const hooks = await this.db.withTenant(job.tenantId, async (db) =>
      (await db.query('select id, url, secret from webhook_endpoint where active and $1 = any(events)', [job.event])).rows);
    const body = JSON.stringify({ event: job.event, at: job.at, data: job.payload });
    const failures: string[] = [];
    for (const h of hooks) {
      const sig = createHmac('sha256', h.secret).update(body).digest('hex');
      try {
        const res = await fetch(h.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-openpark-event': job.event, 'x-openpark-signature': `sha256=${sig}` },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) failures.push(`${h.url}: ${res.status}`);
      } catch (e) {
        failures.push(`${h.url}: ${(e as Error).message}`);
      }
    }
    // Throwing makes pg-boss retry with backoff.
    if (failures.length) throw new Error(`webhook delivery failed: ${failures.join('; ')}`);
  }

  /** Delete plate crops older than the tenant's retention (default 30 days). */
  async purge(app: App) {
    this.admin ??= new pg.Pool({ connectionString: this.cfg.ADMIN_DATABASE_URL, max: 2 });
    const { rows } = await this.admin.query(
      `select r.id, r.crop_key from plate_read r join tenant t on t.id = r.tenant_id
       where r.crop_key is not null
         and r.created_at < now() - make_interval(days => coalesce((t.settings->>'retentionDays')::int, 30))`);
    for (const r of rows) {
      await app.storage.delete(r.crop_key);
      await this.admin.query('update plate_read set crop_key = null where id = $1', [r.id]);
    }
    this.log.info(`retention purge removed ${rows.length} plate crops`);
    return rows.length;
  }

  async stop() {
    await this.boss?.stop({ graceful: false, wait: false }).catch(() => {});
    await this.admin?.end().catch(() => {});
  }
}
