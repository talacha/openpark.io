import { fetch as guardedFetch } from 'undici';
import { assertPublicHost, guardedAgent } from './netguard.js';
import { createHmac } from 'node:crypto';
import PgBoss from 'pg-boss';
import type { Config } from './config.js';
import type { Database } from './db.js';
import type { App } from './server.js';

export type WebhookEvent = 'session.opened' | 'session.closed' | 'slot.changed' | 'read.needs_review' | 'pass.overstay';
interface WebhookJob { tenantId: string; event: WebhookEvent; payload: unknown; at: string }

/** pg-boss queue inside Postgres: webhook delivery with backoff and the retention purge. */
export class Jobs {
  private boss: PgBoss | null = null;

  constructor(private cfg: Config, private db: Database, private log: { error: (e: unknown, m?: string) => void; info: (m: string) => void }) {}

  async start(app: App) {
    if (!this.cfg.JOBS_ENABLED || this.cfg.SERVERLESS) return;
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
    if (this.cfg.SERVERLESS) {
      // No worker to pull from a queue and no function should sleep waiting to retry: persist the delivery, try once now,
      // and let the cron tick retry failures with backoff (see drainDeliveries).
      if (!this.cfg.JOBS_ENABLED) return;
      const id = await this.db.withTenant(tenantId, async (db) => {
        // Most events have no subscriber: do not write (or later read) anything for them.
        const wanted = await db.query('select 1 from webhook_endpoint where active and $1 = any(events) limit 1', [event]);
        if (!wanted.rowCount) return null;
        return (await db.query('insert into webhook_delivery (tenant_id, event, payload) values ($1,$2,$3) returning id', [tenantId, event, JSON.stringify(payload)])).rows[0].id as string;
      });
      if (id) await this.attempt(tenantId, id);
      return;
    }
    if (!this.boss) return;
    await this.boss.send('webhook', { tenantId, event, payload, at: new Date().toISOString() } satisfies WebhookJob,
      { retryLimit: 6, retryBackoff: true, retryDelay: 5 });
  }

  private static readonly BACKOFF_MIN = [1, 5, 30, 120, 720];

  /** One delivery attempt for a stored delivery; records success, or schedules the next try (dead after six). */
  private async attempt(tenantId: string, id: string) {
    const row = await this.db.withTenant(tenantId, async (db) => (await db.query('select * from webhook_delivery where id = $1 and status = $2', [id, 'pending'])).rows[0]);
    if (!row) return false;
    try {
      await this.deliver({ tenantId, event: row.event, payload: row.payload, at: row.at.toISOString() }, 5_000);
      await this.db.withTenant(tenantId, (db) => db.query("update webhook_delivery set status = 'delivered', attempts = attempts + 1 where id = $1", [id]));
      return true;
    } catch (e) {
      const n = row.attempts + 1;
      const dead = n >= Jobs.BACKOFF_MIN.length + 1;
      await this.db.withTenant(tenantId, (db) => db.query(
        `update webhook_delivery set attempts = $2, last_error = $3, status = $4, next_attempt_at = now() + make_interval(mins => $5) where id = $1`,
        [id, n, String((e as Error).message).slice(0, 500), dead ? 'dead' : 'pending', Jobs.BACKOFF_MIN[Math.min(n - 1, Jobs.BACKOFF_MIN.length - 1)]]));
      return false;
    }
  }

  /** Cron tick: retry deliveries whose backoff has elapsed. Bounded per run so a tick stays short. */
  async drainDeliveries(app: App, limit = 25) {
    const due = (await this.db.raw((db) => db.query('select * from due_webhook_deliveries($1, $2)', [app.now(), limit]))).rows as { id: string; tenant_id: string }[];
    let ok = 0;
    for (const d of due) if (await this.attempt(d.tenant_id, d.id)) ok++;
    return { due: due.length, delivered: ok };
  }

  private async deliver(job: WebhookJob, timeoutMs = 10_000) {
    const hooks = await this.db.withTenant(job.tenantId, async (db) =>
      (await db.query('select id, url, secret from webhook_endpoint where active and $1 = any(events)', [job.event])).rows);
    const body = JSON.stringify({ event: job.event, at: job.at, data: job.payload });
    const failures: string[] = [];
    for (const h of hooks) {
      const sig = createHmac('sha256', h.secret).update(body).digest('hex');
      try {
        if (!this.cfg.WEBHOOKS_ALLOW_PRIVATE) await assertPublicHost(h.url);
        const send = this.cfg.WEBHOOKS_ALLOW_PRIVATE ? fetch : ((u: string, init: RequestInit) => guardedFetch(u, { ...init, dispatcher: guardedAgent } as never)) as unknown as typeof fetch;
        const res = await send(h.url, {
          redirect: 'manual',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-openpark-event': job.event, 'x-openpark-signature': `sha256=${sig}` },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) failures.push(`${h.url}: ${res.status}`);
      } catch (e) {
        failures.push(`${h.url}: ${(e as Error).message}`);
      }
    }
    // Throwing makes pg-boss retry with backoff.
    if (failures.length) throw new Error(`webhook delivery failed: ${failures.join('; ')}`);
  }

  /** Delete plate crops older than the tenant's retention (default 30 days), in bounded batches. */
  async purge(app: App) {
    let total = 0;
    for (;;) {
      const { rows } = await this.db.raw((db) => db.query('select * from expired_plate_crops($1)', [200]));
      for (const r of rows as { id: string; crop_key: string }[]) {
        await app.storage.delete(r.crop_key);
        await this.db.raw((db) => db.query('select clear_plate_crop($1)', [r.id]));
      }
      total += rows.length;
      if (rows.length < 200) break;
    }
    this.log.info(`retention purge removed ${total} plate crops`);
    return total;
  }

  async stop() {
    await this.boss?.stop({ graceful: false, wait: false }).catch(() => {});
  }
}
