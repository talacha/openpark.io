import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

/** Object storage adapter. Local disk ships in v1; S3/Azure/GCS implement the same interface. */
export interface Storage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export class LocalDiskStorage implements Storage {
  constructor(private root: string) {}
  private path(key: string) {
    const p = normalize(join(this.root, key));
    if (!p.startsWith(normalize(this.root))) throw new Error('invalid key');
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  get(key: string) { return readFile(this.path(key)); }
  delete(key: string) { return rm(this.path(key), { force: true }); }
}

/** Plate images are only served through short-lived signed URLs. */
export function signUrl(secret: string, key: string, ttlSec = 300, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlSec;
  const sig = createHmac('sha256', secret).update(`${key}.${exp}`).digest('base64url');
  return `/v1/files/${encodeURIComponent(key)}?exp=${exp}&sig=${sig}`;
}

export function verifySignedUrl(secret: string, key: string, exp: number, sig: string, now = Date.now()) {
  if (exp * 1000 < now) return false;
  const want = createHmac('sha256', secret).update(`${key}.${exp}`).digest();
  const got = Buffer.from(sig, 'base64url');
  return got.length === want.length && timingSafeEqual(got, want);
}
