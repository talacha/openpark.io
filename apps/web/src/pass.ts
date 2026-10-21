/** What a guest-pass QR carries. Read client-side for instant feedback and to pre-fill check-in; the server re-verifies everything. */
export interface PassQr { id: string; version: number; code: string; site: string; unit: string; guest: string; plate: string; expires: number }

/** `OPP2|<id>|<version>|<code>|<site>|<unit>|<guest>|<plate hint>|<expiry epoch>|<signature>`; null for anything else. */
export function parsePassQr(text: string): PassQr | null {
  const p = text.trim().split('|');
  if (p.length !== 10 || p[0] !== 'OPP2') return null;
  try {
    const expires = Number(p[8]);
    if (!Number.isFinite(expires)) return null;
    return { id: p[1]!, version: Number(p[2]), code: p[3]!, site: decodeURIComponent(p[4]!), unit: decodeURIComponent(p[5]!), guest: decodeURIComponent(p[6]!), plate: decodeURIComponent(p[7]!), expires };
  } catch { return null; }
}

export const isPassExpired = (q: PassQr, now = Date.now()) => q.expires * (q.expires < 1e12 ? 1000 : 1) <= now;

/** Group the 8-character code for reading aloud: K7Q2 M9XA. */
export const spaceCode = (c: string) => c.replace(/(.{4})(?=.)/g, '$1 ');
