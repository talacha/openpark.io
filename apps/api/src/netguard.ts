import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Private, loopback, link-local, CGNAT, multicast and metadata ranges: places a webhook must never be sent. */
export function isPrivateAddress(addr: string): boolean {
  const a = addr.toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = a.startsWith('::ffff:') ? a.slice(7) : a;
  if (isIP(v4) === 4) {
    const [p, q] = v4.split('.').map(Number) as [number, number];
    return p === 0 || p === 10 || p === 127 || (p === 100 && q >= 64 && q <= 127) || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || p >= 224;
  }
  if (isIP(a) === 6) return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith('ff');
  return true; // not an address we understand
}

/** Cheap check usable in request validation: http(s) only, and not an obviously internal host name or address. */
export function looksPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return false;
  return isIP(host) ? !isPrivateAddress(host) : true;
}

/** Resolve the host right before sending and refuse it if any address is internal (covers DNS pointing at private space). */
export async function assertPublicHost(raw: string): Promise<void> {
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((x) => isPrivateAddress(x.address))) throw new Error('webhook target is not a public address');
}
