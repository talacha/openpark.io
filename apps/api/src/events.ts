import pg from 'pg';

type Listener = (type: string, data: unknown) => void;

/** One LISTEN connection fans out Postgres NOTIFY payloads to SSE subscribers per tenant. */
export class EventHub {
  private subs = new Map<string, Set<Listener>>();
  private client: pg.Client | null = null;
  private closed = false;

  constructor(private url: string, private log: { error: (e: unknown, m?: string) => void }, private perConnection = false) {}

  async start() {
    if (this.perConnection) return; // functions cannot hold a shared connection; each stream opens its own
    const client = new pg.Client({ connectionString: this.url });
    client.on('notification', (n) => {
      if (!n.payload) return;
      const { tenant, type, data } = JSON.parse(n.payload) as { tenant: string; type: string; data: unknown };
      this.subs.get(tenant)?.forEach((fn) => fn(type, data));
    });
    client.on('error', (e) => {
      this.log.error(e, 'event hub connection lost');
      if (!this.closed) setTimeout(() => this.start().catch((err) => this.log.error(err)), 2000);
    });
    await client.connect();
    await client.query('listen openpark_events');
    this.client = client;
  }

  subscribe(tenantId: string, fn: Listener): () => void {
    if (this.perConnection) return this.subscribeDedicated(tenantId, fn);
    let set = this.subs.get(tenantId);
    if (!set) this.subs.set(tenantId, (set = new Set()));
    set.add(fn);
    return () => { set.delete(fn); if (!set.size) this.subs.delete(tenantId); };
  }

  /** One LISTEN connection per open stream, closed when the stream ends. */
  private subscribeDedicated(tenantId: string, fn: Listener): () => void {
    const client = new pg.Client({ connectionString: this.url });
    let closed = false;
    client.on('notification', (n) => {
      if (!n.payload) return;
      const m = JSON.parse(n.payload) as { tenant: string; type: string; data: unknown };
      if (m.tenant === tenantId) fn(m.type, m.data);
    });
    client.on('error', (e) => this.log.error(e, 'sse listen connection error'));
    client.connect().then(() => (closed ? undefined : client.query('listen openpark_events'))).catch((e) => this.log.error(e, 'sse listen failed'));
    return () => { closed = true; void client.end().catch(() => {}); };
  }

  async stop() {
    this.closed = true;
    await this.client?.end().catch(() => {});
  }
}
