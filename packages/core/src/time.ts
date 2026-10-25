/**
 * MicroTs: Microsecond-precision timestamps for OpenPark
 *
 * JavaScript's Date is millisecond-precision only, which is insufficient for
 * ordering events that can occur within the same millisecond (e.g., multiple
 * cars entering a parking lot simultaneously). This module provides:
 *
 * - MicroTs: a branded string type for the wire format (RFC 3339 UTC, 6 fractional digits)
 * - MicroTs as bigint (µs since Unix epoch) for internal computation and sorting
 * - Round-trip-safe conversion functions that preserve full precision
 */

import * as z from 'zod';

/** Wire format: RFC 3339 UTC string with exactly six fractional digits */
export type MicroTs = string & { readonly __brand: 'MicroTs' };

/** Regex for MicroTs validation: YYYY-MM-DDTHH:MM:SS.ffffffZ */
export const MICRO_TS_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z$';
const MICRO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

/**
 * Parse a MicroTs string into microseconds since Unix epoch.
 * Throws RangeError if the string doesn't match the expected format or contains
 * an invalid date (e.g., 2026-02-30, hour 24).
 */
export function parseMicroTs(s: string): bigint {
  const match = s.match(MICRO_RE);
  if (!match) {
    throw new RangeError('invalid MicroTs: ' + s);
  }

  const y = parseInt(match[1]!, 10);
  const mo = parseInt(match[2]!, 10);
  const d = parseInt(match[3]!, 10);
  const h = parseInt(match[4]!, 10);
  const mi = parseInt(match[5]!, 10);
  const se = parseInt(match[6]!, 10);
  const fraction6 = parseInt(match[7]!, 10);

  // Create a Date and verify it round-trips (catches invalid dates like Feb 30)
  const ms = Date.UTC(y, mo - 1, d, h, mi, se);
  const reconstructed = new Date(ms);
  if (
    reconstructed.getUTCFullYear() !== y ||
    reconstructed.getUTCMonth() !== mo - 1 ||
    reconstructed.getUTCDate() !== d ||
    reconstructed.getUTCHours() !== h ||
    reconstructed.getUTCMinutes() !== mi ||
    reconstructed.getUTCSeconds() !== se
  ) {
    throw new RangeError('invalid MicroTs: ' + s);
  }

  return BigInt(ms) * 1000n + BigInt(fraction6);
}

/**
 * Format microseconds since Unix epoch as a MicroTs string.
 * Handles negative values (pre-1970) correctly using proper floor division.
 */
export function formatMicroTs(us: bigint): MicroTs {
  // Proper floor division for negative numbers
  const frac = ((us % 1_000_000n) + 1_000_000n) % 1_000_000n;
  const msWhole = (us - frac) / 1000n;

  const date = new Date(Number(msWhole));
  const y = date.getUTCFullYear();
  const mo = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  const h = date.getUTCHours();
  const mi = date.getUTCMinutes();
  const se = date.getUTCSeconds();

  const fracStr = frac.toString().padStart(6, '0');

  // Format: YYYY-MM-DDTHH:MM:SS.ffffffZ
  const yearStr = y.toString().padStart(4, '0');
  const monthStr = mo.toString().padStart(2, '0');
  const dayStr = d.toString().padStart(2, '0');
  const hourStr = h.toString().padStart(2, '0');
  const minStr = mi.toString().padStart(2, '0');
  const secStr = se.toString().padStart(2, '0');

  return (
    yearStr +
    '-' +
    monthStr +
    '-' +
    dayStr +
    'T' +
    hourStr +
    ':' +
    minStr +
    ':' +
    secStr +
    '.' +
    fracStr +
    'Z'
  ) as MicroTs;
}

/**
 * Compare two MicroTs values.
 * Returns -1 if a < b, 0 if a == b, 1 if a > b.
 */
export function compareMicroTs(a: MicroTs | string, b: MicroTs | string): -1 | 0 | 1 {
  const aUs = parseMicroTs(a);
  const bUs = parseMicroTs(b);
  if (aUs < bUs) return -1;
  if (aUs > bUs) return 1;
  return 0;
}

/**
 * Type guard: check if a value is a valid MicroTs string.
 */
export function isMicroTs(s: unknown): s is MicroTs {
  if (typeof s !== 'string') return false;
  try {
    parseMicroTs(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert input to MicroTs with back-compat for older formats.
 * Accepts:
 * - MicroTs (returned as-is after validation)
 * - ISO-8601 strings with 0-9 fractional digits and Z or ±hh:mm offset
 * - Date objects (ms precision, padded with 000)
 *
 * This is the back-compat path for old queued items with ms ISO strings.
 */
export function toMicroTs(input: string | Date): MicroTs {
  if (isMicroTs(input)) {
    return input;
  }

  if (input instanceof Date) {
    const ms = input.getTime();
    const us = BigInt(ms) * 1000n;
    return formatMicroTs(us);
  }

  // Parse ISO-8601 string with optional offset
  const s = input.trim();
  
  // Try MicroTs format first
  if (MICRO_RE.test(s)) {
    try {
      return parseMicroTs(s) as unknown as MicroTs;
    } catch {
      // Fall through to general parsing
    }
  }

  // General ISO-8601 parser
  // Handle Z or ±hh:mm offset
  let base = s;
  let offsetMinutes = 0n;

  if (s.endsWith('Z')) {
    base = s.slice(0, -1);
  } else {
    // Match ±hh:mm offset
    const offsetMatch = s.match(/([+-])(\d{2}):(\d{2})$/);
    if (offsetMatch) {
      const sign = offsetMatch[1] === '+' ? 1n : -1n;
      const hours = BigInt(offsetMatch[2]!);
      const mins = BigInt(offsetMatch[3]!);
      offsetMinutes = sign * (hours * 60n + mins);
      base = s.slice(0, offsetMatch.index!);
    }
  }

  // Parse base part: YYYY-MM-DDTHH:MM:SS[.fraction]
  const partsMatch = base.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!partsMatch) {
    throw new RangeError('invalid ISO-8601: ' + s);
  }

  const y = parseInt(partsMatch[1]!, 10);
  const mo = parseInt(partsMatch[2]!, 10);
  const d = parseInt(partsMatch[3]!, 10);
  const h = parseInt(partsMatch[4]!, 10);
  const mi = parseInt(partsMatch[5]!, 10);
  const se = parseInt(partsMatch[6]!, 10);
  const fracStr = partsMatch[7] || '0';

  // Validate date
  const ms = Date.UTC(y, mo - 1, d, h, mi, se);
  const reconstructed = new Date(ms);
  if (
    reconstructed.getUTCFullYear() !== y ||
    reconstructed.getUTCMonth() !== mo - 1 ||
    reconstructed.getUTCDate() !== d ||
    reconstructed.getUTCHours() !== h ||
    reconstructed.getUTCMinutes() !== mi ||
    reconstructed.getUTCSeconds() !== se
  ) {
    throw new RangeError('invalid date: ' + s);
  }

  // Convert fractional seconds to microseconds (6 digits)
  // Truncate beyond 6 digits, pad below 6
  let frac6: bigint;
  if (fracStr.length === 0) {
    frac6 = 0n;
  } else if (fracStr.length <= 6) {
    frac6 = BigInt(fracStr.padEnd(6, '0'));
  } else {
    // Truncate to 6 digits
    frac6 = BigInt(fracStr.slice(0, 6));
  }

  // Apply offset: subtract offsetMinutes (negative for west of UTC)
  const offsetUs = BigInt(offsetMinutes) * 60n * 1000000n;
  const baseUs = BigInt(ms) * 1000n + frac6;
  const resultUs = baseUs - offsetUs;

  return formatMicroTs(resultUs);
}

/**
 * Generate a strictly monotonically increasing MicroTs.
 *
 * In browser: uses performance.timeOrigin + performance.now() for sub-millisecond
 * precision, converted to integer µs.
 *
 * In Node/other environments: falls back to BigInt(Date.now()) * 1000n.
 *
 * The value is made strictly increasing per process by bumping 1 µs when it
 * would not increase (handles clock resolution and call batching).
 */
let lastNowUs = 0n;

export function nowMicroTs(): MicroTs {
  let current: bigint;

  if (typeof globalThis.performance !== 'undefined' && 
      typeof globalThis.performance?.timeOrigin === 'number' && 
      typeof globalThis.performance.now === 'function') {
    // Browser with high-res timer
    const nowMs = globalThis.performance.timeOrigin + globalThis.performance.now();
    current = BigInt(Math.round(nowMs * 1000));
  } else {
    // Fallback: Date.now() (ms precision)
    current = BigInt(Date.now()) * 1000n;
  }

  // Ensure strictly increasing per process
  if (current <= lastNowUs) {
    current = lastNowUs + 1n;
  }
  lastNowUs = current;

  return formatMicroTs(current);
}

/**
 * Zod schema for MicroTs validation.
 * Uses the MICRO_TS_PATTERN for regex validation.
 */
export const microTsSchema = z.string().regex(new RegExp(MICRO_TS_PATTERN));
