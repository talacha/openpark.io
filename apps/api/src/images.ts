import { createHash } from 'node:crypto';
import { normalizePlate } from '@openpark/core';
import sharp from 'sharp';
import type { Db } from './db.js';
import { HttpError } from './http.js';

/**
 * Images live in Postgres as a BLOB (`image_asset.data`). The primary key is a deterministic hash of the
 * image's *identity*, not its bytes:
 *
 *   tenant + type + subject (email or plate) + event/action + optional department number
 *
 * That makes storing idempotent: re-uploading a resident's avatar or a fresh photo of the same immobilized
 * vehicle replaces the existing row instead of accumulating objects. The content hash (`sha256`) is kept
 * separately for ETags and integrity checks.
 *
 * @example
 * // A resident's avatar is keyed by email.
 * await imageAsset(db, tenantId, { type: 'avatar', subject: 'ana@example.com' }, jpeg);
 *
 * // Enforcement evidence is keyed by plate (plus region), so a re-photo replaces the old evidence.
 * await imageAsset(db, tenantId, { type: 'immobilization', subject: 'ABC-123', region: 'MX-CMX' }, jpeg);
 *
 * // A unit-scoped asset can add the optional department number and event.
 * await imageAsset(db, tenantId, {
 *   type: 'violation', subject: 'ABC-123', region: 'MX-CMX',
 *   event: 'overstay', departmentNumber: 'B2-047',
 * }, jpeg);
 */

export const IMAGE_KEY_VERSION = 'image/v1';

/** How `subject` is normalised before hashing. Inferred from `type` when omitted. */
export type SubjectKind = 'email' | 'plate' | 'text';

export interface ImageIdentity {
  /** What the image is: `avatar`, `violation`, `immobilization`, `plate_crop`, … Lower-case, dots allowed. */
  type: string;
  /** Stable identity: an email address for people, a plate for vehicles. */
  subject: string;
  /** Defaults from `type` (avatars/profiles → email, violations/immobilization → plate, else text). */
  subjectKind?: SubjectKind;
  /** Event or action that distinguishes two assets for the same subject, e.g. `overstay`. */
  event?: string | null;
  /** Optional department/unit number the asset belongs to. */
  departmentNumber?: string | number | null;
  /** Plate region, so the same plate text in two regions stays distinct. */
  region?: string | null;
  /** Longest output edge in pixels. Defaults to 512 for avatars and 1600 for everything else. Not hashed. */
  maxEdge?: number;
  /** WebP quality (1-100). Defaults to 80. Not hashed. */
  quality?: number;
}

export interface ImageAsset {
  key: string;
  type: string;
  subjectKind: SubjectKind;
  subject: string;
  region: string | null;
  event: string | null;
  departmentNumber: string | null;
  mime: string;
  data: Buffer;
  bytes: number;
  width: number;
  height: number;
  /** SHA-256 of the optimised bytes, not of the identity. */
  sha256: string;
  createdAt: Date;
  updatedAt: Date;
  /** True when this call inserted the row; false when it replaced or reused one. */
  created: boolean;
}

interface NormalisedIdentity {
  type: string;
  subjectKind: SubjectKind;
  subject: string;
  region: string | null;
  event: string | null;
  departmentNumber: string | null;
  maxEdge: number;
  quality: number;
}

interface ImageRow {
  key: string;
  type: string;
  subject_kind: SubjectKind;
  subject: string;
  region: string | null;
  event: string | null;
  department_number: string | null;
  mime: string;
  data: Buffer;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  created_at: Date;
  updated_at: Date;
  created: boolean;
}

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const DEFAULT_QUALITY = 80;
const DEFAULT_MAX_EDGE = 1600;
const AVATAR_MAX_EDGE = 512;
const ALLOWED_INPUT_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif', 'gif', 'heif', 'tiff']);

const TYPE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EMAIL_TYPES = new Set(['avatar', 'profile']);
const PLATE_TYPES = new Set(['violation', 'immobilization', 'evidence']);

function inferSubjectKind(type: string): SubjectKind {
  if (EMAIL_TYPES.has(type) || type.startsWith('user.')) return 'email';
  if (PLATE_TYPES.has(type) || type.startsWith('enforcement.')) return 'plate';
  return 'text';
}

function maxEdgeFor(type: string): number {
  return EMAIL_TYPES.has(type) || type.startsWith('user.') ? AVATAR_MAX_EDGE : DEFAULT_MAX_EDGE;
}

function text(value: string | number | null | undefined, field: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  const out = String(value).trim().normalize('NFC');
  if (!out) return null;
  if (out.length > max) throw new HttpError(400, 'image_identity_invalid', `${field} is longer than ${max} characters`);
  return out;
}

function normalise(identity: ImageIdentity): NormalisedIdentity {
  const type = identity.type.trim().toLowerCase();
  if (!TYPE_RE.test(type)) throw new HttpError(400, 'image_identity_invalid', 'type must be lower-case letters, digits, dots, underscores or dashes');

  const subjectKind = identity.subjectKind ?? inferSubjectKind(type);
  const rawSubject = text(identity.subject, 'subject', 320);
  if (!rawSubject) throw new HttpError(400, 'image_identity_invalid', 'subject is required');

  const subject = subjectKind === 'email'
    ? rawSubject.toLowerCase()
    : subjectKind === 'plate'
      ? normalizePlate(rawSubject)
      : rawSubject;
  if (!subject) throw new HttpError(400, 'image_identity_invalid', 'subject is empty after normalisation');

  const maxEdge = identity.maxEdge ?? maxEdgeFor(type);
  if (!Number.isInteger(maxEdge) || maxEdge < 64 || maxEdge > 4096) throw new HttpError(400, 'image_identity_invalid', 'maxEdge must be an integer between 64 and 4096');
  const quality = identity.quality ?? DEFAULT_QUALITY;
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new HttpError(400, 'image_identity_invalid', 'quality must be an integer between 1 and 100');

  return {
    type,
    subjectKind,
    subject,
    region: text(identity.region, 'region', 16)?.toUpperCase() ?? null,
    event: text(identity.event, 'event', 64)?.toLowerCase() ?? null,
    departmentNumber: text(identity.departmentNumber, 'departmentNumber', 64)?.toUpperCase() ?? null,
    maxEdge,
    quality,
  };
}

/**
 * Deterministic key for an image identity. The same tenant + type + subject + event/action + department
 * always produces the same key, regardless of casing, surrounding whitespace, or plate separators.
 */
export function imageKey(tenantId: string, identity: ImageIdentity): string {
  return keyOf(tenantId, normalise(identity));
}

/**
 * The URL-safe storage key used to serve a DB-backed image through `GET /v1/files/:key`. The tenant is part of
 * the key so the public, signature-only route can select the right RLS context without an authenticated request.
 */
export function imageStorageKey(tenantId: string, key: string): string {
  return `${tenantId}/db/${key}.webp`;
}

/** Parse a key minted by {@link imageStorageKey}; returns null for ordinary object-storage keys. */
export function parseImageStorageKey(storageKey: string): { tenantId: string; key: string } | null {
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/db\/([a-f0-9]{64})\.webp$/.exec(storageKey);
  return match ? { tenantId: match[1]!, key: match[2]! } : null;
}

function keyOf(tenantId: string, n: NormalisedIdentity): string {
  const canonical = JSON.stringify([
    IMAGE_KEY_VERSION,
    tenantId,
    n.type,
    n.subjectKind,
    n.subject,
    n.region,
    n.event,
    n.departmentNumber,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

async function optimise(data: Buffer, n: NormalisedIdentity) {
  if (!data.length) throw new HttpError(400, 'image_invalid', 'The image is empty');
  if (data.length > MAX_INPUT_BYTES) throw new HttpError(400, 'image_too_large', 'Images must be 10 MiB or smaller');

  let format: string | undefined;
  try {
    format = (await sharp(data, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()).format;
  } catch {
    throw new HttpError(400, 'image_invalid', 'The image could not be decoded');
  }
  if (!format || !ALLOWED_INPUT_FORMATS.has(format)) throw new HttpError(400, 'image_unsupported', `Unsupported image format: ${format ?? 'unknown'}`);

  try {
    const { data: out, info } = await sharp(data, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate() // honour EXIF orientation before stripping metadata
      .resize({ width: n.maxEdge, height: n.maxEdge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: n.quality, effort: 4, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
    return {
      data: out,
      mime: 'image/webp',
      bytes: out.length,
      width: info.width,
      height: info.height,
      sha256: createHash('sha256').update(out).digest('hex'),
    };
  } catch {
    throw new HttpError(400, 'image_invalid', 'The image could not be processed');
  }
}

function toAsset(row: ImageRow): ImageAsset {
  return {
    key: row.key,
    type: row.type,
    subjectKind: row.subject_kind,
    subject: row.subject,
    region: row.region,
    event: row.event,
    departmentNumber: row.department_number,
    mime: row.mime,
    data: Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data),
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    created: row.created,
  };
}

/**
 * Store or retrieve an image in one call.
 *
 * - `imageAsset(db, tenantId, identity, bytes)` optimises `bytes` to WebP and upserts it under the identity's
 *   deterministic key, returning the stored asset. Passing the same identity again replaces the bytes; passing
 *   identical bytes is a no-op (same row, same `updatedAt`).
 * - `imageAsset(db, tenantId, identity)` loads the asset for that identity, or `null` when there is none.
 *
 * The caller must already be inside `Database.withTenant()`, so RLS scopes the row to the tenant.
 */
export async function imageAsset(
  db: Db,
  tenantId: string,
  identity: ImageIdentity,
  image?: Buffer,
): Promise<ImageAsset | null> {
  const n = normalise(identity);
  const key = keyOf(tenantId, n);

  if (image === undefined) return imageAssetByKey(db, tenantId, key);

  const optimised = await optimise(image, n);
  const inserted = await db.query<ImageRow>(
    `insert into image_asset (tenant_id, key, type, subject_kind, subject, region, event, department_number,
       mime, data, bytes, width, height, sha256)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (tenant_id, key) do nothing
     returning key, type, subject_kind, subject, region, event, department_number, mime, data, bytes, width, height,
       sha256, created_at, updated_at, true as created`,
    [tenantId, key, n.type, n.subjectKind, n.subject, n.region, n.event, n.departmentNumber,
      optimised.mime, optimised.data, optimised.bytes, optimised.width, optimised.height, optimised.sha256],
  );
  if (inserted.rows[0]) return toAsset(inserted.rows[0]);

  // Same identity already exists: rewrite the blob only when the content actually changed, so a retry is a no-op.
  const replaced = await db.query<ImageRow>(
    `update image_asset
     set mime = $3, data = $4, bytes = $5, width = $6, height = $7, sha256 = $8, updated_at = clock_timestamp()
     where tenant_id = $1 and key = $2 and sha256 <> $8
     returning key, type, subject_kind, subject, region, event, department_number, mime, data, bytes, width, height,
       sha256, created_at, updated_at, false as created`,
    [tenantId, key, optimised.mime, optimised.data, optimised.bytes, optimised.width, optimised.height, optimised.sha256],
  );
  if (replaced.rows[0]) return toAsset(replaced.rows[0]);

  const existing = await db.query<ImageRow>(
    `select key, type, subject_kind, subject, region, event, department_number, mime, data, bytes, width, height, sha256,
       created_at, updated_at, false as created
     from image_asset where tenant_id = $1 and key = $2`,
    [tenantId, key],
  );
  return existing.rows[0] ? toAsset(existing.rows[0]) : null;
}

/**
 * Load an image by the deterministic key embedded in an {@link imageStorageKey}. The public, signature-only file
 * route knows that key but not the identity that produced it, so it cannot go through {@link imageAsset}.
 */
export async function imageAssetByKey(db: Db, tenantId: string, key: string): Promise<ImageAsset | null> {
  const found = await db.query<ImageRow>(
    `select key, type, subject_kind, subject, region, event, department_number, mime, data, bytes, width, height, sha256,
       created_at, updated_at, false as created
     from image_asset where tenant_id = $1 and key = $2`,
    [tenantId, key],
  );
  return found.rows[0] ? toAsset(found.rows[0]) : null;
}
