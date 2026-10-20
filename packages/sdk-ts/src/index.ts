import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export class OpenParkError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); this.name = 'OpenParkError'; }
}

export interface ClientOptions {
  baseUrl: string;
  /** Tenant API key (`op_…`) or a user token. */
  apiKey: string;
  /** Required with a user token that belongs to several tenants. */
  tenant?: string;
  fetch?: typeof fetch;
}

export interface CheckInInput {
  site: string;
  plate: { display: string; region?: string };
  vehicle?: { bodyType?: string; make?: string; model?: string; color?: string; year?: number };
  slot?: string;
  source?: 'manual' | 'ai_assist' | 'ai_auto';
}

export interface CheckOutInput {
  site: string;
  plate?: string;
  ticket?: string;
  region?: string;
  lostTicket?: boolean;
  override?: { fee: number; reason: string };
  payment?: { method: 'cash' | 'card' | 'account'; amount: number; receiptNo?: string };
}

type Json = Record<string, any>;

export class OpenPark {
  private readonly f: typeof fetch;
  constructor(private readonly o: ClientOptions) { this.f = o.fetch ?? fetch; }

  /** Every write carries an Idempotency-Key. Pass your own to make a retry safe across process restarts. */
  async request<T = Json>(method: string, path: string, opts: { body?: unknown; query?: Record<string, string | number | boolean | undefined>; idempotencyKey?: string } = {}): Promise<T> {
    const q = Object.entries(opts.query ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)] as [string, string]);
    const url = `${this.o.baseUrl.replace(/\/$/, '')}${path}${q.length ? `?${new URLSearchParams(q)}` : ''}`;
    const write = method !== 'GET';
    const res = await this.f(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.o.apiKey.startsWith('op_') ? { 'x-api-key': this.o.apiKey } : { authorization: `Bearer ${this.o.apiKey}` }),
        ...(this.o.tenant ? { 'x-tenant': this.o.tenant } : {}),
        ...(write ? { 'idempotency-key': opts.idempotencyKey ?? randomUUID() } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new OpenParkError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? res.statusText, data?.error?.details);
    return data as T;
  }

  checkIn(input: CheckInInput, idempotencyKey?: string) { return this.request('POST', '/v1/sessions', { body: input, idempotencyKey }); }
  checkOut(input: CheckOutInput, idempotencyKey?: string) { return this.request('POST', '/v1/checkout', { body: input, idempotencyKey }); }
  checkOutSession(id: string, body: Omit<CheckOutInput, 'site' | 'plate' | 'ticket'> = {}, idempotencyKey?: string) { return this.request('POST', `/v1/sessions/${id}/checkout`, { body, idempotencyKey }); }
  sessions(query: { site?: string; status?: string; from?: string; to?: string; plate?: string; limit?: number; offset?: number } = {}) { return this.request('GET', '/v1/sessions', { query }); }
  sessionEvents(id: string) { return this.request<Json[]>('GET', `/v1/sessions/${id}/events`); }
  slots(query: { site: string; status?: string; type?: string; zone?: string }) { return this.request<Json[]>('GET', '/v1/slots', { query }); }
  occupancy(site?: string) { return this.request('GET', '/v1/occupancy', { query: { site } }); }
  setSlotStatus(site: string, code: string, status: 'available' | 'out_of_service' | 'reserved', note?: string) { return this.request('PATCH', `/v1/slots/${encodeURIComponent(code)}`, { query: { site }, body: { status, note } }); }
  quote(ratePlanId: string, inAt: string, outAt: string) { return this.request('POST', `/v1/rate-plans/${ratePlanId}/quote`, { body: { inAt, outAt } }); }
  exportInventory(site?: string, zone?: string) { return this.request('GET', '/v1/inventory/export', { query: { site, zone } }); }
  previewInventory(doc: unknown, mode: 'merge' | 'replace' = 'merge', dryRun = false) { return this.request('POST', '/v1/inventory/import', { query: { mode, dryRun }, body: doc }); }
  applyInventory(job: string) { return this.request('POST', `/v1/inventory/import/${job}/apply`); }
  rollbackInventory(job: string) { return this.request('POST', `/v1/inventory/import/${job}/rollback`); }
}

/**
 * Verify a webhook: `X-OpenPark-Signature: sha256=<hex>` is HMAC-SHA256 of the raw request body
 * with the endpoint's signing secret. Pass the exact bytes received, not re-serialised JSON.
 */
export function verifyWebhook(rawBody: string | Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const want = createHmac('sha256', secret).update(rawBody).digest();
  const got = Buffer.from(signatureHeader.slice(7), 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}
