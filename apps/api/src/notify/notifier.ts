import type { Config } from '../config.js';

export interface Recipient { email?: string | null; phone?: string | null }
export interface Message { to: Recipient; subject: string; body: string }
export interface Delivery { channel: 'email' | 'sms' | 'whatsapp' | 'console'; id?: string }

/** Delivers one message over whatever channels the recipient and the deployment support. */
export interface Notifier {
  /** Returns the deliveries that succeeded; an empty list means the recipient was undeliverable. Throws if every attempt failed. */
  send(m: Message): Promise<Delivery[]>;
}

type Log = { info: (m: string) => void; error: (e: unknown, m?: string) => void };

class ResendEmail {
  constructor(private key: string, private from: string) {}
  async send(to: string, subject: string, body: string): Promise<Delivery> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.from, to, subject, text: body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { channel: 'email', id: ((await res.json()) as { id?: string }).id };
  }
}

class TwilioPhone {
  constructor(private sid: string, private token: string, private from: string, private channel: 'sms' | 'whatsapp') {}
  async send(to: string, body: string): Promise<Delivery> {
    const wa = (n: string) => (this.channel === 'whatsapp' ? `whatsapp:${n}` : n);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${this.sid}:${this.token}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: wa(this.from), To: wa(to), Body: body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { channel: this.channel, id: ((await res.json()) as { sid?: string }).sid };
  }
}

/** Email and phone are independent channels: a message goes to every channel the recipient has and we can reach. */
class CompositeNotifier implements Notifier {
  constructor(private email: ResendEmail | null, private phone: TwilioPhone | null, private log: Log) {}
  async send(m: Message): Promise<Delivery[]> {
    const jobs: Promise<Delivery>[] = [];
    if (m.to.email && this.email) jobs.push(this.email.send(m.to.email, m.subject, m.body));
    if (m.to.phone && this.phone) jobs.push(this.phone.send(m.to.phone, `${m.subject}\n${m.body}`));
    if (!jobs.length) {
      this.log.info(`undeliverable message (no configured channel for recipient): ${m.subject}`);
      return [];
    }
    const results = await Promise.allSettled(jobs);
    const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (!ok.length) throw (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason;
    return ok;
  }
}

export function createNotifier(cfg: Config, log: Log): Notifier {
  const email = cfg.RESEND_API_KEY && cfg.MAIL_FROM ? new ResendEmail(cfg.RESEND_API_KEY, cfg.MAIL_FROM) : null;
  const phone = cfg.TWILIO_ACCOUNT_SID && cfg.TWILIO_AUTH_TOKEN && cfg.TWILIO_FROM
    ? new TwilioPhone(cfg.TWILIO_ACCOUNT_SID, cfg.TWILIO_AUTH_TOKEN, cfg.TWILIO_FROM, cfg.NOTIFY_PHONE_CHANNEL) : null;
  return new CompositeNotifier(email, phone, log);
}
