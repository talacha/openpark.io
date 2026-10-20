import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OpenPark, OpenParkError, verifyWebhook } from '../src/index.js';

function client(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return handler(url, init); }) as unknown as typeof fetch;
  return { api: new OpenPark({ baseUrl: 'https://app.example.com/', apiKey: 'op_abc', fetch: f }), calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('OpenPark client', () => {
  it('sends the API key and an Idempotency-Key on writes, none on reads', async () => {
    const { api, calls } = client(() => json({ ok: true }));
    await api.checkIn({ site: 'S1', plate: { display: 'ABC123' } });
    await api.occupancy('S1');
    const h = (i: number) => calls[i]!.init.headers as Record<string, string>;
    expect(calls[0]!.url).toBe('https://app.example.com/v1/sessions');
    expect(h(0)['x-api-key']).toBe('op_abc');
    expect(h(0)['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1]!.url).toBe('https://app.example.com/v1/occupancy?site=S1');
    expect(h(1)['idempotency-key']).toBeUndefined();
  });
  it('reuses a caller-supplied idempotency key so retries are safe', async () => {
    const { api, calls } = client(() => json({}));
    await api.checkOut({ site: 'S1', plate: 'ABC123' }, 'order-42');
    expect((calls[0]!.init.headers as Record<string, string>)['idempotency-key']).toBe('order-42');
  });
  it('uses Bearer for user tokens and sends the tenant', async () => {
    const calls: RequestInit[] = [];
    const api = new OpenPark({ baseUrl: 'http://x', apiKey: 'eyJ.tok.en', tenant: 'acme', fetch: (async (_u: string, i: RequestInit) => { calls.push(i); return json({}); }) as unknown as typeof fetch });
    await api.sessions({ status: 'open', limit: 5 });
    expect(calls[0]!.headers).toMatchObject({ authorization: 'Bearer eyJ.tok.en', 'x-tenant': 'acme' });
  });
  it('raises OpenParkError with the API error code and details', async () => {
    const { api } = client(() => json({ error: { code: 'already_inside', message: 'Inside since 08:12', details: { slot: 'B2-014' } } }, 409));
    const e = await api.checkIn({ site: 'S1', plate: { display: 'X' } }).catch((x) => x);
    expect(e).toBeInstanceOf(OpenParkError);
    expect(e).toMatchObject({ status: 409, code: 'already_inside', details: { slot: 'B2-014' } });
  });
});

describe('verifyWebhook', () => {
  const secret = 'whsec_test';
  const body = '{"event":"session.opened","data":{"slot":"B1-001"}}';
  const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  it('accepts the signature the API produces', () => expect(verifyWebhook(body, sig, secret)).toBe(true));
  it('rejects a tampered body, wrong secret, and malformed headers', () => {
    expect(verifyWebhook(body + ' ', sig, secret)).toBe(false);
    expect(verifyWebhook(body, sig, 'other')).toBe(false);
    expect(verifyWebhook(body, undefined, secret)).toBe(false);
    expect(verifyWebhook(body, 'sha256=zz', secret)).toBe(false);
    expect(verifyWebhook(body, sig.replace('sha256=', 'md5='), secret)).toBe(false);
  });
});
