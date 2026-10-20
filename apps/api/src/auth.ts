import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type Role = 'owner' | 'admin' | 'supervisor' | 'attendant' | 'auditor';

const ALL = ['read', 'checkin', 'checkout', 'payment', 'slot.status', 'fee.override', 'session.void', 'inventory.edit',
  'inventory.import', 'rate_plan.edit', 'settings.edit', 'users.edit', 'audit.read', 'tenant.delete'] as const;
export type Permission = (typeof ALL)[number];

const PERMS: Record<Role, readonly Permission[]> = {
  owner: ALL,
  admin: ALL.filter((p) => p !== 'tenant.delete'),
  supervisor: ['read', 'checkin', 'checkout', 'payment', 'slot.status', 'fee.override', 'session.void'],
  attendant: ['read', 'checkin', 'checkout', 'payment', 'slot.status'],
  auditor: ['read', 'audit.read'],
};
export const can = (role: Role, p: Permission) => PERMS[role].includes(p);

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(pw, salt, 32)).toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), 32);
  const want = Buffer.from(hash, 'base64');
  return got.length === want.length && timingSafeEqual(got, want);
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export interface TokenClaims { sub: string; exp: number; }

/** Compact HS256 JWT; enough for first-party session tokens. */
export function signToken(secret: string, sub: string, ttlSec = 12 * 3600, now = Date.now()): string {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ sub, exp: Math.floor(now / 1000) + ttlSec }));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest();
  return `${head}.${body}.${b64u(sig)}`;
}

export function verifyToken(secret: string, token: string, now = Date.now()): TokenClaims | null {
  const [head, body, sig] = token.split('.');
  if (!head || !body || !sig) return null;
  const want = createHmac('sha256', secret).update(`${head}.${body}`).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenClaims;
  return claims.exp * 1000 > now ? claims : null;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function newApiKey(): { key: string; prefix: string; hash: string } {
  const key = `op_${randomBytes(24).toString('base64url')}`;
  return { key, prefix: key.slice(0, 10), hash: sha256(key) };
}

export function newTicketCode(): string {
  return randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').toUpperCase().slice(0, 8);
}
