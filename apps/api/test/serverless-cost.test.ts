import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, idem, signup, tenantId, waitFor, type Harness, type Tenant } from './helpers.js';

/** On serverless hosts nothing may hold a connection open or sleep waiting to retry: streams are off, retries are durable. */
let h: Harness;
let owner: Tenant;
let server: http.Server;
let url: string;
const hits: { body: string; sig: string }[] = [];
let respond = 500;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { hits.push({ body, sig: String(req.headers['x-openpark-signature']) }); res.statusCode = respond; res.end('x'); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  h = await harness({ env: { WEBHOOKS_ALLOW_PRIVATE: 'true', SERVERLESS: 'true', JOBS_ENABLED: 'true', SSE_ENABLED: 'false', CRON_SECRET: 'cron-secret-123' } });
  owner = await signup(h.app, 'US');
});
afterAll(async () => { await h.close(); await new Promise((r) => server.close(r)); });

const cron = () => h.app.inject({ method: 'GET', url: '/v1/cron/pass-reminders', headers: { authorization: 'Bearer cron-secret-123' } });
const deliveries = async () => h.app.db.withTenant(await tenantId(owner.slug), async (db) =>
  (await db.query('select status, attempts, last_error, next_attempt_at from webhook_delivery order by at')).rows);

describe('no long-held connections on serverless', () => {
  it('turns the stream off and tells clients to poll', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/v1/config' })).json()).toMatchObject({ realtime: 'poll' });
    const r = await h.app.inject({ method: 'GET', url: '/v1/events', headers: owner.h });
    expect(r.statusCode).toBe(501);
    expect(r.json().error.code).toBe('realtime_polling');
  });
});

describe('durable webhook retries', () => {
  it('attempts once, stores the failure, and lets the cron tick retry with backoff until delivered', async () => {
    h.clock.now = new Date(); // delivery times are set by the database clock, so run on real time
    const hook = (await h.app.inject({ method: 'POST', url: '/v1/webhooks', headers: owner.h, payload: { url, events: ['session.opened'] } })).json();
    respond = 500;
    await h.app.inject({ method: 'POST', url: '/v1/sessions', headers: idem(owner), payload: { site: 'DEMO-01', plate: { display: 'WHK-001' } } });

    await waitFor(() => hits.length === 1);
    const [first] = await waitFor(async () => { const d = await deliveries(); return d.length && d[0].attempts === 1 ? d : null; });
    expect(first).toMatchObject({ status: 'pending', attempts: 1 });
    expect(first.last_error).toContain('500');
    expect(new Date(first.next_attempt_at).getTime()).toBeGreaterThan(Date.now()); // a backoff is scheduled, nothing is sleeping

    let res = (await cron()).json();
    expect(res.webhooks).toEqual({ due: 0, delivered: 0 }); // not due yet
    expect(hits).toHaveLength(1);

    h.clock.now = new Date(Date.now() + 2 * 60_000); // past the 1-minute backoff
    respond = 200;
    res = (await cron()).json();
    expect(res.webhooks).toEqual({ due: 1, delivered: 1 });
    expect(hits).toHaveLength(2);
    expect((await deliveries())[0]).toMatchObject({ status: 'delivered', attempts: 2 });

    // The receiver can verify what it got, exactly as documented for the SDKs.
    const want = `sha256=${createHmac('sha256', hook.secret).update(hits[1]!.body).digest('hex')}`;
    expect(hits[1]!.sig).toBe(want);
    expect(JSON.parse(hits[1]!.body)).toMatchObject({ event: 'session.opened', data: { slot: expect.any(String) } });

    expect((await cron()).json().webhooks).toEqual({ due: 0, delivered: 0 }); // delivered rows are never resent
  });

  it('gives up after six attempts instead of retrying forever', async () => {
    const t = await signup(h.app, 'US');
    h.clock.now = new Date();
    await h.app.inject({ method: 'POST', url: '/v1/webhooks', headers: t.h, payload: { url, events: ['session.opened'] } });
    respond = 500;
    hits.length = 0;
    await h.app.inject({ method: 'POST', url: '/v1/sessions', headers: idem(t), payload: { site: 'DEMO-01', plate: { display: 'DED-001' } } });
    await waitFor(() => hits.length === 1);
    const rows = async () => h.app.db.withTenant(await tenantId(t.slug), async (db) => (await db.query('select status, attempts from webhook_delivery')).rows[0]);
    await waitFor(async () => (await rows())?.attempts === 1);
    for (let i = 0; i < 6 && (await rows()).status === 'pending'; i++) {
      h.clock.now = new Date(Date.now() + (i + 1) * 24 * 3_600_000); // well past every backoff
      await cron();
    }
    expect(await rows()).toMatchObject({ status: 'dead', attempts: 6 });
    const before = hits.length;
    h.clock.now = new Date(Date.now() + 30 * 24 * 3_600_000);
    await cron();
    expect(hits.length).toBe(before); // dead deliveries are left alone
  });

  it('keeps suspended tenants quiet', async () => {
    const t = await signup(h.app, 'US');
    h.clock.now = new Date();
    await h.app.inject({ method: 'POST', url: '/v1/webhooks', headers: t.h, payload: { url, events: ['session.opened'] } });
    respond = 500;
    await h.app.inject({ method: 'POST', url: '/v1/sessions', headers: idem(t), payload: { site: 'DEMO-01', plate: { display: 'SUS-001' } } });
    await waitFor(async () => h.app.db.withTenant(await tenantId(t.slug), async (db) => (await db.query('select 1 from webhook_delivery where attempts = 1')).rowCount));
    await h.app.db.withTenant(await tenantId(t.slug), (db) => db.query("update tenant set suspended_at = now()"));
    h.clock.now = new Date(Date.now() + 3600_000);
    const before = hits.length;
    await cron();
    expect(hits.length).toBe(before);
  });
});

describe('retention purge without owner credentials', () => {
  it('removes expired plate crops through restricted functions, leaving fresh ones and other settings alone', async () => {
    const t = await signup(h.app, 'US');
    const id = await tenantId(t.slug);
    await h.app.storage.put('old.jpg', Buffer.from('x'));
    await h.app.storage.put('new.jpg', Buffer.from('y'));
    await h.app.db.withTenant(id, async (db) => {
      await db.query("insert into plate_read (tenant_id, crop_key, created_at) values ($1, 'old.jpg', now() - interval '40 days'), ($1, 'new.jpg', now() - interval '2 days')", [id]);
    });
    expect(await h.app.jobs.purge(h.app)).toBeGreaterThanOrEqual(1);
    const rows = await h.app.db.withTenant(id, async (db) => (await db.query('select crop_key from plate_read order by created_at')).rows);
    expect(rows.map((r) => r.crop_key)).toEqual([null, 'new.jpg']);
    await expect(h.app.storage.get('old.jpg')).rejects.toThrow();
    expect((await h.app.storage.get('new.jpg')).toString()).toBe('y');
    // A tenant that keeps images longer is respected.
    await h.app.db.withTenant(id, (db) => db.query("update tenant set settings = settings || '{\"retentionDays\": 90}'"));
    await h.app.storage.put('mid.jpg', Buffer.from('z'));
    await h.app.db.withTenant(id, (db) => db.query("insert into plate_read (tenant_id, crop_key, created_at) values ($1, 'mid.jpg', now() - interval '40 days')", [id]));
    await h.app.jobs.purge(h.app);
    expect((await h.app.storage.get('mid.jpg')).toString()).toBe('z');
  });
});
