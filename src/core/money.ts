/**
 * Money utilities — fixed-precision only. Monetary values travel as strings
 * matching /^\d+(\.\d{1,2})?$/ and are persisted as PostgreSQL NUMERIC(14,2).
 * Floating point is never used for money (spec §1.3, §26, §28.4).
 * Arithmetic happens on BigInt cents.
 */

export const CURRENCY = 'INR';

/** Client-confirmed business constants (spec §5, §9–§13, §22.2). */
export const BUSINESS_RULES = {
  MIN_BALANCE_AFTER_WITHDRAWAL: '100.00',
  HIGH_VALUE_WITHDRAWAL_LIMIT: '200000.00',
  SAVINGS_MIN_BALANCE: '100.00',
  FD_MIN_AMOUNT: '1000.00',
  FD_MAX_AMOUNT: '100000.00',
  FD_LIEN_LOAN_PERCENT: 85, // loan against FD ≤ 85% of FD amount
  COLLATERAL_LENDING_PERCENT: 60, // loan ≤ 60% of collateral value
  GUARANTOR_MAX_ACTIVE_LOANS: 2,
  RD_GRACE_PERIOD_MONTHS: 1,
  RD_EARLY_CLOSURE_FEE_PERCENT: 4, // 4% closure fee
  DISPUTE_WINDOW_MONTHS: 3,
  MIN_INTEREST_RATE: 4, // flexible 4%–25%+ per product
  MAX_INTEREST_RATE: 25,
} as const;

const MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

export function isValidMoney(value: string): boolean {
  return MONEY_PATTERN.test(value);
}

export function assertMoney(value: string, field = 'amount'): void {
  if (!isValidMoney(value)) {
    throw new Error(`${field} must be a non-negative amount with at most 2 decimal places: ${value}`);
  }
}

/** Convert a money string (or integer cents) to BigInt minor units (paise). */
export function toCents(value: string): bigint {
  assertMoney(value);
  const [whole, fraction = ''] = value.split('.');
  const paddedFraction = (fraction + '00').slice(0, 2);
  return BigInt(whole ?? '0') * 100n + BigInt(paddedFraction);
}

/** Convert BigInt minor units back to a canonical money string. */
export function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = absolute % 100n;
  const result = `${whole}.${fraction.toString().padStart(2, '0')}`;
  return negative ? `-${result}` : result;
}

export function addMoney(a: string, b: string): string {
  return fromCents(toCents(a) + toCents(b));
}

export function subMoney(a: string, b: string): string {
  return fromCents(toCents(a) - toCents(b));
}

/** Multiply a money value by a decimal factor given as a percent string, e.g. ('1000.00', '4.00') → '40.00'. */
export function percentOf(amount: string, percent: string): string {
  const amountCents = toCents(amount);
  const [wholePercent, fractionPercent = ''] = percent.split('.');
  const percentBasisPoints = BigInt(wholePercent ?? '0') * 100n + BigInt((fractionPercent + '00').slice(0, 2) || '0');
  return fromCents((amountCents * percentBasisPoints) / 10000n);
}

export function compareMoney(a: string, b: string): number {
  const ca = toCents(a);
  const cb = toCents(b);
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

export function isZero(value: string): boolean {
  return toCents(value) === 0n;
}

export function isPositive(value: string): boolean {
  return toCents(value) > 0n;
}

export function isNegative(value: string): boolean {
  return toCents(value) < 0n;
}

/** Max of two money strings. */
export function maxMoney(a: string, b: string): string {
  return compareMoney(a, b) >= 0 ? a : b;
}

/**
 * Allocate an amount across weights (e.g. instalment split) without losing a
 * single paise — the last bucket absorbs the remainder.
 */
export function allocateByWeights(amount: string, weights: bigint[]): string[] {
  const totalCents = toCents(amount);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0n);
  if (totalWeight === 0n) return weights.map(() => '0.00');
  const results: string[] = [];
  let allocated = 0n;
  for (let i = 0; i < weights.length; i += 1) {
    const weight = weights[i] ?? 0n;
    if (i === weights.length - 1) {
      results.push(fromCents(totalCents - allocated));
    } else {
      const share = (totalCents * weight) / totalWeight;
      results.push(fromCents(share));
      allocated += share;
    }
  }
  return results;
}

/** en-IN / INR formatting for all customer/staff-facing output (spec §3). */
export function formatINR(value: string | number): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(numeric);
}
