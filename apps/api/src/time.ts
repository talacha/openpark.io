/**
 * Microsecond-precision time utilities for API routes
 *
 * Exports resolveEffectiveAt which implements the server ordering rules for
 * session_event rows as per audit-offline-sync.md section 2.4.
 *
 * Wire format: ISO-8601 UTC string with exactly 6 fractional digits, e.g.
 * '2026-10-24T16:31:33.430512Z'. This matches MicroTs from @openpark/core.
 */

import type { MicroTs } from '@openpark/core';
import { parseMicroTs, formatMicroTs, compareMicroTs } from '@openpark/core';

/** Default clock gap threshold in seconds: 300 s (5 min) */
export const CLOCK_GAP_SEC = 300;

/** Maximum clock ahead for offline replays: 5 seconds */
export const MAX_FUTURE_SEC = 5;

/** Maximum age for client time in offline replays: 48 hours */
export const MAX_PAST_HOURS = 48;

/**
 * Clock verdict: what the server decided about the client's reported time.
 * Returns a pure result with rejected flag instead of throwing errors.
 */
export interface ClockVerdict {
  effectiveAt: MicroTs;         // The authoritative timestamp for billing/ordering
  flag: null | 'clock_ahead' | 'clock_gap';  // Optional flag for special cases
  rejected: boolean;            // true if deviceAt is out of window
}

/**
 * Server clock time in MicroTs format.
 * Uses clock_timestamp() via SQL, never app.now() for persisted times.
 * This function should be called once per request and passed to handlers.
 * Explicitly uses UTC to avoid timezone-related bugs.
 */
export async function serverMicroTs(db: { query: (sql: string) => Promise<{ rows: { clock_timestamp: string }[] }> }): Promise<MicroTs> {
  const { rows } = await db.query("select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as clock_timestamp");
  return rows[0]?.clock_timestamp as MicroTs;
}

/**
 * Parse a MicroTs string from the wire into a bigint.
 * Returns the parsed microseconds or throws on invalid format.
 */
export function parseMicroTsStrict(s: string): bigint {
  return parseMicroTs(s);
}

/**
 * Format microseconds since Unix epoch as a MicroTs string.
 */
export function formatMicroTsStrict(us: bigint): MicroTs {
  return formatMicroTs(us);
}

/**
 * Compare two MicroTs values.
 * Returns -1 if a < b, 0 if a == b, 1 if a > b.
 */
export function compareMicroTsStrict(a: MicroTs | string, b: MicroTs | string): -1 | 0 | 1 {
  return compareMicroTs(a, b);
}

/**
 * Server acceptance rules for clientAt (device capture time).
 * Implements the ordering logic per PLAN.md "Ordering on the server".
 * Pure function - returns verdict, does not throw errors.
 *
 * Rules (ALL requests, regardless of offline flag):
 * 1. No clientAt → use server (receivedAt), legacy clients
 * 2. clientAt more than 5 s in the future → clamp to receivedAt and flag 'clock_ahead'
 * 3. clientAt older than 48 h → rejected = true
 * 4. Otherwise effectiveAt = clientAt
 * 5. If |clientAt - receivedAt| > 300 s, add 'clock_gap' flag (warning stored on the event)
 * 6. rejected is true for out-of-window cases
 *
 * @param args.clientAt - Client's reported capture time (optional; may be undefined for legacy clients)
 * @param args.receivedAt - Server's arrival time (MicroTs from clock_timestamp())
 * @param args.maxPastHours - Maximum age for client time (default: 48)
 * @param args.maxFutureSec - Maximum future time (default: 5)
 * @param args.gapApprovalSec - Clock gap threshold (default: 300)
 */
export function resolveEffectiveAt(args: {
  clientAt?: string;
  receivedAt: MicroTs;
  maxPastHours?: number;
  maxFutureSec?: number;
  gapApprovalSec?: number;
}): ClockVerdict {
  const {
    clientAt,
    receivedAt,
    maxPastHours = MAX_PAST_HOURS,
    maxFutureSec = MAX_FUTURE_SEC,
    gapApprovalSec = CLOCK_GAP_SEC,
  } = args;

  // Rule 1: No clientAt → use server (receivedAt), legacy clients
  if (clientAt === undefined || clientAt === null) {
    return {
      effectiveAt: receivedAt,
      flag: null,
      rejected: false,
    };
  }

  // Parse clientAt and receivedAt to bigint for comparison
  let clientUs: bigint;
  let receivedUs: bigint;
  try {
    clientUs = parseMicroTs(clientAt);
    receivedUs = parseMicroTs(receivedAt);
  } catch {
    // If parsing fails, treat as rejected
    return {
      effectiveAt: receivedAt,
      flag: null,
      rejected: true,
    };
  }

  // Compute window boundaries using integer-safe math (microseconds)
  const maxPastUs = BigInt(Math.round(maxPastHours * 3_600_000_000)); // 48h in µs
  const maxFutureUs = BigInt(Math.round(maxFutureSec * 1_000_000));   // 5s in µs
  const gapThresholdUs = BigInt(Math.round(gapApprovalSec * 1_000_000)); // 300s in µs

  // Rule 3: Older than 48 h → rejected (receivedUs - clientUs > maxPastUs means clientAt < receivedAt - 48h)
  if (receivedUs - clientUs > maxPastUs) {
    return {
      effectiveAt: receivedAt,
      flag: null,
      rejected: true,
    };
  }

  // Rule 2: More than 5 s in the future → clamp to receivedAt and flag 'clock_ahead'
  const clockAhead = clientUs - receivedUs;
  if (clockAhead > maxFutureUs) {
    return {
      effectiveAt: receivedAt,
      flag: 'clock_ahead',
      rejected: false,
    };
  }

  // Rule 5: If |gap| > 300 s, add 'clock_gap' flag
  const absGapUs = clockAhead >= 0n ? clockAhead : -clockAhead;
  const flag = absGapUs > gapThresholdUs ? 'clock_gap' : null;

  return {
    effectiveAt: formatMicroTs(clientUs),
    flag,
    rejected: false,
  };
}
