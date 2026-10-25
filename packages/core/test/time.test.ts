import { describe, expect, it, vi } from 'vitest';
import {
  parseMicroTs,
  formatMicroTs,
  compareMicroTs,
  isMicroTs,
  toMicroTs,
  nowMicroTs,
  microTsSchema,
  MICRO_TS_PATTERN,
} from '../src/index.js';

describe('parseMicroTs', () => {
  it('parses valid MicroTs strings', () => {
    expect(parseMicroTs('1970-01-01T00:00:00.000000Z')).toBe(0n);
    // 2026-10-24T16:31:33.430512Z = 1792859493000ms + 430512µs = 1792859493430512n
    expect(parseMicroTs('2026-10-24T16:31:33.430512Z')).toBe(1792859493430512n);
    // 9999-12-31T23:59:59.999999Z
    const maxMs = Date.UTC(9999, 11, 31, 23, 59, 59);
    expect(parseMicroTs('9999-12-31T23:59:59.999999Z')).toBe(BigInt(maxMs) * 1000n + 999999n);
  });

  it('handles negative timestamps (pre-1970)', () => {
    // 1969-12-31T23:59:59.000000Z = -1000ms = -1000000µs
    expect(parseMicroTs('1969-12-31T23:59:59.000000Z')).toBe(-1000000n);
    // 1900-01-01T00:00:00.000000Z
    expect(parseMicroTs('1900-01-01T00:00:00.000000Z')).toBe(-2208988800000000n);
  });

  it('round-trips with formatMicroTs', () => {
    const testValues = [
      0n,
      1n,
      -1n,
      1792859493430512n,
      BigInt(Date.UTC(9999, 11, 31, 23, 59, 59)) * 1000n + 999999n,
      -2208988800000000n,
    ];
    for (const us of testValues) {
      const formatted = formatMicroTs(us);
      expect(parseMicroTs(formatted)).toBe(us);
    }
  });

  it('rejects strings without Z suffix', () => {
    expect(() => parseMicroTs('2026-10-24T16:31:33.430512')).toThrow(RangeError);
  });

  it('rejects strings with wrong fractional digit count', () => {
    expect(() => parseMicroTs('2026-10-24T16:31:33.430Z')).toThrow(RangeError); // 3 digits
    expect(() => parseMicroTs('2026-10-24T16:31:33.4305123Z')).toThrow(RangeError); // 7 digits
  });

  it('rejects invalid dates', () => {
    expect(() => parseMicroTs('2026-02-30T16:31:33.430512Z')).toThrow(RangeError); // Feb 30
    expect(() => parseMicroTs('2026-02-29T16:31:33.430512Z')).toThrow(RangeError); // non-leap year
    expect(() => parseMicroTs('2024-02-29T16:31:33.430512Z')).not.toThrow(); // leap year OK
  });

  it('rejects invalid time components', () => {
    expect(() => parseMicroTs('2026-10-24T24:00:00.000000Z')).toThrow(RangeError);
    expect(() => parseMicroTs('2026-10-24T23:60:00.000000Z')).toThrow(RangeError);
    expect(() => parseMicroTs('2026-10-24T23:59:60.000000Z')).toThrow(RangeError);
  });
});

describe('formatMicroTs', () => {
  it('formats epoch correctly', () => {
    expect(formatMicroTs(0n)).toBe('1970-01-01T00:00:00.000000Z');
  });

  it('formats positive values correctly', () => {
    expect(formatMicroTs(1792859493430512n)).toBe('2026-10-24T16:31:33.430512Z');
  });

  it('formats negative values correctly', () => {
    expect(formatMicroTs(-1000000n)).toBe('1969-12-31T23:59:59.000000Z');
    expect(formatMicroTs(-1n)).toBe('1969-12-31T23:59:59.999999Z');
  });

  it('handles leap day', () => {
    // 2024-02-29T23:59:59.999999Z
    const ms = Date.UTC(2024, 1, 29, 23, 59, 59);
    expect(formatMicroTs(BigInt(ms) * 1000n + 999999n)).toBe('2024-02-29T23:59:59.999999Z');
  });
});

describe('compareMicroTs', () => {
  it('compares equal values as 0', () => {
    expect(compareMicroTs('2026-10-24T16:31:33.430512Z', '2026-10-24T16:31:33.430512Z')).toBe(0);
  });

  it('compares a < b as -1', () => {
    expect(compareMicroTs('2026-10-24T16:31:33.430511Z', '2026-10-24T16:31:33.430512Z')).toBe(-1);
  });

  it('compares a > b as 1', () => {
    expect(compareMicroTs('2026-10-24T16:31:33.430513Z', '2026-10-24T16:31:33.430512Z')).toBe(1);
  });

  it('compares at 1µs granularity', () => {
    const base = '2026-10-24T16:31:33.430512Z';
    expect(compareMicroTs(base, '2026-10-24T16:31:33.430511Z')).toBe(1);
    expect(compareMicroTs(base, '2026-10-24T16:31:33.430512Z')).toBe(0);
    expect(compareMicroTs(base, '2026-10-24T16:31:33.430513Z')).toBe(-1);
  });
});

describe('isMicroTs', () => {
  it('returns true for valid MicroTs', () => {
    expect(isMicroTs('2026-10-24T16:31:33.430512Z')).toBe(true);
  });

  it('returns false for invalid values', () => {
    expect(isMicroTs('2026-10-24T16:31:33.43051Z')).toBe(false); // 5 digits
    expect(isMicroTs('2026-10-24T16:31:33.4305123Z')).toBe(false); // 7 digits
    expect(isMicroTs('2026-10-24T16:31:33.430512')).toBe(false); // no Z
    expect(isMicroTs('not a timestamp')).toBe(false);
    expect(isMicroTs(123 as unknown as string)).toBe(false);
    expect(isMicroTs(null as unknown as string)).toBe(false);
  });
});

describe('toMicroTs', () => {
  it('accepts MicroTs strings', () => {
    const input = '2026-10-24T16:31:33.430512Z';
    expect(toMicroTs(input)).toBe(input);
  });

  it('accepts Date objects', () => {
    const date = new Date('2026-10-24T16:31:33.430Z');
    const result = toMicroTs(date);
    expect(result).toBe('2026-10-24T16:31:33.430000Z');
  });

  it('handles ms ISO strings', () => {
    expect(toMicroTs('2026-10-24T16:31:33.430Z')).toBe('2026-10-24T16:31:33.430000Z');
  });

  it('handles 9-digit nanosecond strings (truncates)', () => {
    expect(toMicroTs('2026-10-24T16:31:33.123456789Z')).toBe('2026-10-24T16:31:33.123456Z');
  });

  it('handles 3-digit strings (pads)', () => {
    expect(toMicroTs('2026-10-24T16:31:33.123Z')).toBe('2026-10-24T16:31:33.123000Z');
  });

  it('handles +05:30 offset', () => {
    // 2026-10-24T16:31:33.430512+05:30 = 2026-10-24T11:01:33.430512Z
    expect(toMicroTs('2026-10-24T16:31:33.430512+05:30')).toBe('2026-10-24T11:01:33.430512Z');
  });

  it('handles -08:00 offset', () => {
    // 2026-10-24T16:31:33.430512-08:00 = 2026-10-25T00:31:33.430512Z
    expect(toMicroTs('2026-10-24T16:31:33.430512-08:00')).toBe('2026-10-25T00:31:33.430512Z');
  });
});

describe('nowMicroTs', () => {
  it('returns a valid MicroTs', () => {
    const result = nowMicroTs();
    expect(isMicroTs(result)).toBe(true);
  });

  it('is strictly increasing', () => {
    const values: string[] = [];
    for (let i = 0; i < 10000; i++) {
      values.push(nowMicroTs());
    }
    for (let i = 1; i < values.length; i++) {
      expect(compareMicroTs(values[i - 1], values[i])).toBe(-1);
    }
  });
});

describe('microTsSchema', () => {
  it('validates correct MicroTs', () => {
    expect(microTsSchema.parse('2026-10-24T16:31:33.430512Z')).toBe('2026-10-24T16:31:33.430512Z');
  });

  it('rejects invalid formats', () => {
    expect(() => microTsSchema.parse('2026-10-24T16:31:33.43051Z')).toThrow();
    expect(() => microTsSchema.parse('2026-10-24T16:31:33.4305123Z')).toThrow();
    expect(() => microTsSchema.parse('2026-10-24T16:31:33.430512')).toThrow();
  });
});

describe('MICRO_TS_PATTERN', () => {
  it('exports the regex source string', () => {
    expect(MICRO_TS_PATTERN).toBe('^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z$');
  });
});
