import { describe, expect, it } from 'vitest';
import { RateRules, computeFee } from '../src/index.js';

const rules = RateRules.parse({
  graceMin: 10, firstPeriodMin: 60, firstPeriodFee: 3000, incrementMin: 15, incrementFee: 1000,
  dailyCap: 25000, lostTicketFee: 30000, taxMode: 'included', taxRate: 0.16,
});
const at = (hhmm: string, day = 20) => new Date(`2026-10-${day}T${hhmm}:00Z`);

describe('computeFee', () => {
  it('matches the worked example: 08:12 to 14:09 is $230.00', () => {
    const r = computeFee(rules, at('08:12'), at('14:09'));
    expect(r.minutes).toBe(357);
    expect(r.total).toBe(23000);
  });
  it('charges nothing inside the grace period', () => {
    expect(computeFee(rules, at('08:00'), at('08:10')).total).toBe(0);
  });
  it('charges the first period for short stays', () => {
    expect(computeFee(rules, at('08:00'), at('08:11')).total).toBe(3000);
    expect(computeFee(rules, at('08:00'), at('09:00')).total).toBe(3000);
  });
  it('charges per started increment', () => {
    expect(computeFee(rules, at('08:00'), at('09:01')).total).toBe(4000);
    expect(computeFee(rules, at('08:00'), at('09:15')).total).toBe(4000);
    expect(computeFee(rules, at('08:00'), at('09:16')).total).toBe(5000);
  });
  it('applies the daily cap', () => {
    expect(computeFee(rules, at('00:00'), at('23:59')).total).toBe(25000);
  });
  it('applies the cap per 24h block from check-in', () => {
    const r = computeFee(rules, at('08:00', 20), at('09:30', 22)); // 49.5h = 2 days + 90 min
    expect(r.total).toBe(2 * 25000 + 3000 + 1000 * 2);
  });
  it('uses the flat lost-ticket fee', () => {
    expect(computeFee(rules, at('08:00'), at('09:00'), { lostTicket: true }).total).toBe(30000);
  });
  it('reports included tax without changing the total', () => {
    const r = computeFee(rules, at('08:12'), at('14:09'));
    expect(r.tax).toBe(Math.round((23000 * 0.16) / 1.16));
  });
  it('adds tax when taxMode is added', () => {
    const r = computeFee({ ...rules, taxMode: 'added' }, at('08:00'), at('09:00'));
    expect(r.total).toBe(3480);
  });
  it('rejects negative durations', () => {
    expect(() => computeFee(rules, at('09:00'), at('08:00'))).toThrow(RangeError);
  });
});
