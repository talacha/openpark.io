import { z } from 'zod';

/** Rate-plan rules. All money is integer minor units (cents/centavos). */
export const RateRules = z.object({
  graceMin: z.number().int().min(0).default(0),
  firstPeriodMin: z.number().int().min(1),
  firstPeriodFee: z.number().int().min(0),
  incrementMin: z.number().int().min(1),
  incrementFee: z.number().int().min(0),
  dailyCap: z.number().int().min(0).nullable().default(null),
  lostTicketFee: z.number().int().min(0).default(0),
  taxMode: z.enum(['included', 'added', 'none']).default('none'),
  taxRate: z.number().min(0).max(1).default(0),
});
export type RateRules = z.infer<typeof RateRules>;

export interface FeeLine {
  label: string;
  amount: number;
}

export interface FeeResult {
  minutes: number;
  /** Amount the guest pays, in minor units. */
  total: number;
  /** Tax portion of `total`. */
  tax: number;
  lines: FeeLine[];
}

const DAY_MIN = 24 * 60;

/** Whole minutes between two instants; partial minutes are not charged. */
export function stayMinutes(inAt: Date, outAt: Date): number {
  const ms = outAt.getTime() - inAt.getTime();
  if (ms < 0) throw new RangeError('out_at precedes in_at');
  return Math.floor(ms / 60_000);
}

function blockFee(r: RateRules, t: number): number {
  if (t <= 0) return 0;
  if (t <= r.firstPeriodMin) return r.firstPeriodFee;
  const raw = r.firstPeriodFee + r.incrementFee * Math.ceil((t - r.firstPeriodMin) / r.incrementMin);
  return r.dailyCap === null ? raw : Math.min(r.dailyCap, raw);
}

/**
 * fee = min(cap, P1 + p * ceil((t - T1) / delta)), with the cap applied per
 * 24 h block counted from check-in. The grace period applies to the whole stay.
 */
export function computeFee(
  rules: RateRules,
  inAt: Date,
  outAt: Date,
  opts: { lostTicket?: boolean } = {},
): FeeResult {
  const t = stayMinutes(inAt, outAt);
  const lines: FeeLine[] = [];
  let base: number;

  if (opts.lostTicket) {
    base = rules.lostTicketFee;
    lines.push({ label: 'lost_ticket', amount: base });
  } else if (t <= rules.graceMin) {
    base = 0;
    lines.push({ label: 'grace', amount: 0 });
  } else {
    const days = rules.dailyCap === null ? 0 : Math.floor(t / DAY_MIN);
    const rem = rules.dailyCap === null ? t : t - days * DAY_MIN;
    base = 0;
    if (days > 0) {
      const amount = days * (rules.dailyCap as number);
      base += amount;
      lines.push({ label: `daily_cap x${days}`, amount });
    }
    if (rem > 0) {
      const first = Math.min(rem, rules.firstPeriodMin);
      const fee = blockFee(rules, rem);
      const increments = rem > rules.firstPeriodMin ? Math.ceil((rem - rules.firstPeriodMin) / rules.incrementMin) : 0;
      base += fee;
      lines.push({ label: `first_period ${first}min`, amount: rules.firstPeriodFee });
      if (increments > 0) lines.push({ label: `increments x${increments}`, amount: rules.incrementFee * increments });
      const capped = rules.firstPeriodFee + rules.incrementFee * increments - fee;
      if (capped > 0) lines.push({ label: 'cap_adjustment', amount: -capped });
    }
  }

  let tax = 0;
  let total = base;
  if (rules.taxMode === 'included') tax = Math.round((base * rules.taxRate) / (1 + rules.taxRate));
  else if (rules.taxMode === 'added') {
    tax = Math.round(base * rules.taxRate);
    total = base + tax;
    if (tax) lines.push({ label: 'tax', amount: tax });
  }
  return { minutes: t, total, tax, lines };
}
