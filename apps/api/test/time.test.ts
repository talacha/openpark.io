/**
 * Tests for time.ts - resolveEffectiveAt function
 * Tests the exact boundary conditions specified in R2-04
 * 
 * Rules (applied in order):
 * 1. No clientAt → use server (receivedAt)
 * 2. clientAt > receivedAt + 5s → clamp to receivedAt and flag 'clock_ahead'
 * 3. clientAt < receivedAt - 48h → rejected = true
 * 4. Otherwise effectiveAt = clientAt, add 'clock_gap' flag if |gap| > 300s
 */

import { describe, it, expect } from 'vitest';
import { resolveEffectiveAt } from '../src/time.js';

// Helper to create a MicroTs from a Date-like string (6 fractional digits)
function toMicroTs(s: string): string {
  // Ensure exactly 6 fractional digits
  const base = s.replace(/\.(\d{3})Z$/, '.$1000Z');
  if (!base.match(/\.\d{6}Z$/)) {
    throw new Error('Invalid input: must be ISO format with ms');
  }
  return base;
}

describe('resolveEffectiveAt', () => {
  const baseTime = '2026-10-24T12:00:00.000000Z';
  const receivedAt = toMicroTs(baseTime);

  describe('missing deviceAt', () => {
    it('returns receivedAt when clientAt is undefined', () => {
      const result = resolveEffectiveAt({ clientAt: undefined, receivedAt });
      expect(result.effectiveAt).toBe(receivedAt);
      expect(result.flag).toBe(null);
      expect(result.rejected).toBe(false);
    });

    it('returns receivedAt when clientAt is null', () => {
      const result = resolveEffectiveAt({ clientAt: null, receivedAt });
      expect(result.effectiveAt).toBe(receivedAt);
      expect(result.flag).toBe(null);
      expect(result.rejected).toBe(false);
    });
  });

  describe('clock_ahead boundary (+5 seconds)', () => {
    // exactly +5 seconds is NOT > 5s, so should be accepted with no flag
    it('exactly +5 seconds is accepted with no flag', () => {
      const clientAt = toMicroTs('2026-10-24T12:00:05.000000Z');
      const result = resolveEffectiveAt({ clientAt, receivedAt });
      expect(result.effectiveAt).toBe(clientAt);
      expect(result.flag).toBe(null);
      expect(result.rejected).toBe(false);
    });

    // +5 seconds + 1 microsecond IS > 5s, so should be clamped with clock_ahead flag
    it('+5s + 1us is clamped with clock_ahead flag', () => {
      const clientAt = toMicroTs('2026-10-24T12:00:05.000001Z');
      const result = resolveEffectiveAt({ clientAt, receivedAt });
      expect(result.effectiveAt).toBe(receivedAt);
      expect(result.flag).toBe('clock_ahead');
      expect(result.rejected).toBe(false);
    });
  });

  describe('48 hour boundary', () => {
    // exactly -48 hours is NOT < receivedAt - 48h (it equals), so not rejected
    // But the gap is 48h = 172,800s > 300s, so clock_gap flag is set
    it('exactly -48 hours is not rejected with clock_gap flag', () => {
      const clientAt = toMicroTs('2026-10-22T12:00:00.000000Z');
      const result = resolveEffectiveAt({ clientAt, receivedAt });
      expect(result.effectiveAt).toBe(clientAt);
      expect(result.flag).toBe('clock_gap');
      expect(result.rejected).toBe(false);
    });

    // -48 hours - 1 microsecond IS < receivedAt - 48h, so rejected
    it('-48h - 1us is rejected', () => {
      const clientAt = toMicroTs('2026-10-22T11:59:59.999999Z');
      const result = resolveEffectiveAt({ clientAt, receivedAt });
      expect(result.rejected).toBe(true);
      // effectiveAt should be receivedAt for rejected cases
      expect(result.effectiveAt).toBe(receivedAt);
      expect(result.flag).toBe(null);
    });
  });

  describe('clock_gap boundary (300 seconds)', () => {
    // exactly 300 seconds gap is NOT > 300s, so no flag (but effectiveAt is still clientAt)
    it('negative exactly 300 seconds gap has no flag', () => {
      const clientAt = toMicroTs('2026-10-24T11:55:00.000000Z'); // -300s
      const result = resolveEffectiveAt({ clientAt, receivedAt });
      expect(result.effectiveAt).toBe(clientAt);
      expect(result.flag).toBe(null);
      expect(result.rejected).toBe(false);
    });

    // 300 seconds + 1 microsecond gap IS > 300s, so clock_gap flag
    it('negative 300s + 1us gap has clock_gap flag', () => {
      const clientAt = toMicroTs('2026-10-24T11:54:59.999999Z'); // -300.000001s
      const result = resolveEffectiveAt({ clientAt, receivedAt });
      expect(result.effectiveAt).toBe(clientAt);
      expect(result.flag).toBe('clock_gap');
      expect(result.rejected).toBe(false);
    });

    // positive exactly 300 seconds is > 5s, so clamped with clock_ahead (not clock_gap)
    it('positive exactly 300 seconds is clamped with clock_ahead flag', () => {
      const clientAt = toMicroTs('2026-10-24T12:05:00.000000Z'); // +300s
      const result = resolveEffectiveAt({ clientAt, receivedAt });
      // +300s > +5s, so clamped
      expect(result.effectiveAt).toBe(receivedAt);
      expect(result.flag).toBe('clock_ahead');
      expect(result.rejected).toBe(false);
    });

    // positive 300s + 1us is also > 5s, so clamped with clock_ahead
    it('positive 300s + 1us is clamped with clock_ahead flag', () => {
      const clientAt = toMicroTs('2026-10-24T12:05:00.000001Z'); // +300.000001s
      const result = resolveEffectiveAt({ clientAt, receivedAt });
      expect(result.effectiveAt).toBe(receivedAt);
      expect(result.flag).toBe('clock_ahead');
      expect(result.rejected).toBe(false);
    });
  });

  describe('normal cases', () => {
    it('within normal range uses clientAt with no flag', () => {
      const clientAt = toMicroTs('2026-10-24T12:00:01.500000Z');
      const result = resolveEffectiveAt({ clientAt, receivedAt });
      expect(result.effectiveAt).toBe(clientAt);
      expect(result.flag).toBe(null);
      expect(result.rejected).toBe(false);
    });

    it('slightly ahead of receivedAt is accepted without flag', () => {
      const clientAt = toMicroTs('2026-10-24T12:00:02.000000Z'); // +2s
      const result = resolveEffectiveAt({ clientAt, receivedAt });
      expect(result.effectiveAt).toBe(clientAt);
      expect(result.flag).toBe(null);
      expect(result.rejected).toBe(false);
    });

    it('slightly behind receivedAt is accepted without flag', () => {
      const clientAt = toMicroTs('2026-10-24T11:59:58.500000Z'); // -1.5s
      const result = resolveEffectiveAt({ clientAt, receivedAt });
      expect(result.effectiveAt).toBe(clientAt);
      expect(result.flag).toBe(null);
      expect(result.rejected).toBe(false);
    });
  });

  describe('invalid input', () => {
    it('garbage input is rejected', () => {
      const clientAt = 'not-a-date';
      const result = resolveEffectiveAt({ clientAt, receivedAt });
      expect(result.rejected).toBe(true);
      expect(result.effectiveAt).toBe(receivedAt);
      expect(result.flag).toBe(null);
    });

    it('invalid MicroTs format is rejected', () => {
      const clientAt = toMicroTs('2026-13-45T99:99:99.999999Z'); // invalid date
      const result = resolveEffectiveAt({ clientAt, receivedAt });
      expect(result.rejected).toBe(true);
      expect(result.effectiveAt).toBe(receivedAt);
      expect(result.flag).toBe(null);
    });
  });
});
