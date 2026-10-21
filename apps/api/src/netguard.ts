import { lookup } from 'node:dns';
import { lookup as lookupAsync } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';

/** Parse an IPv6 address (including `::` and a dotted IPv4 tail) into 16 bytes. */
function v6Bytes(addr: string): number[] | null {
  let s = addr;
  const tail4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail4) { const q = tail4[2]!.split('.').map(Number); s = `${tail4[1]}${((q[0]! << 8) | q[1]!).toString(16)}:${((q[2]! << 8) | q[3]!).toString(16)}`; }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = [...head, ...(halves.length === 2 ? Array<string>(fill).fill('0') : []), ...rest];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    out.push(n >> 8, n & 255);
  }
  return out.length === 16 ? out : null;
}

function privateV4(p: number, q: number, r: number): boolean {
  return p === 0 || p === 10 || p === 127 || p >= 224
    || (p === 100 && q >= 64 && q <= 127) || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168)
    || (p === 192 && q === 0 && (r === 0 || r === 2)) || (p === 198 && (q === 18 || q === 19)) || (p === 198 && q === 51 && r === 100) || (p === 203 && q === 0 && r === 113);
}

/** Private, loopback, link-local, CGNAT, documentation, multicast and metadata space, including IPv4 hidden inside IPv6. */
export function isPrivateAddress(addr: string): boolean {
  const a = addr.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (isIP(a) === 4) { const [p, q, r] = a.split('.').map(Number) as [number, number, number]; return privateV4(p, q, r); }
  if (isIP(a) !== 6) return true; // not an address we understand
  const b = v6Bytes(a);
  if (!b) return true;
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255) return privateV4(b[12]!, b[13]!, b[14]!); // IPv4-mapped ::ffff:a.b.c.d
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) return privateV4(b[12]!, b[13]!, b[14]!); // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return true; // 6to4: nothing legitimate to deliver webhooks to
  if (b[0] === 0x20 && b[1] === 0x01 && (b[2] === 0 || (b[2] === 0x0d && b[3] === 0xb8))) return true; // Teredo, documentation
  if (b.every((x) => x === 0) || b.slice(0, 15).every((x) => x === 0)) return true; // :: and ::1 (and ::a.b.c.d)
  return (b[0]! & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1]! & 0xc0) >= 0x80) || b[0] === 0xff; // unique-local, link-local/site-local, multicast
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

/** Resolve the host and refuse it if any address is internal. The connection itself is also guarded (see guardedAgent). */
export async function assertPublicHost(raw: string): Promise<void> {
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookupAsync(host, { all: true });
  if (!addrs.length || addrs.some((x) => isPrivateAddress(x.address))) throw new Error('webhook target is not a public address');
}

/**
 * An HTTP client whose DNS lookup rejects private addresses at connect time, so a name that changes its answer between the
 * check and the connection (DNS rebinding) cannot reach internal space.
 */
export const guardedAgent = new Agent({
  connect: {
    lookup(hostname, options, cb) {
      lookup(hostname, { ...options, all: true }, (err, addrs) => {
        if (err) return cb(err, '', 4);
        const list = addrs as unknown as { address: string; family: number }[];
        if (!list.length || list.some((x) => isPrivateAddress(x.address))) return cb(new Error('webhook target is not a public address'), '', 4);
        if ((options as { all?: boolean }).all) return (cb as unknown as (e: null, a: unknown) => void)(null, list);
        return cb(null, list[0]!.address, list[0]!.family);
      });
    },
  },
});
