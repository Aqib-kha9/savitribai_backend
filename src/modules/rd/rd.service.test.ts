process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
process.env.JWT_ACCESS_SECRET = '01234567890123456789012345678901';

import { describe, it, expect, beforeAll } from 'vitest';
import { monthsBetween, addMonths } from '../../core/time.js';

describe('Backend RD Term & Installment Scheduling Unit Tests', () => {
  let getExpectedInstallmentCount: typeof import('./rd.service.js').getExpectedInstallmentCount;

  beforeAll(async () => {
    const mod = await import('./rd.service.js');
    getExpectedInstallmentCount = mod.getExpectedInstallmentCount;
  });

  it('correctly derives months between two dates', () => {
    expect(monthsBetween('2026-10-16', '2027-10-16')).toBe(12);
    expect(monthsBetween('2026-09-16', '2027-09-16')).toBe(12);
    expect(monthsBetween('2026-09-16', '2028-09-16')).toBe(24);
    expect(monthsBetween('2026-09-16', '2036-09-16')).toBe(120);
  });

  it('calculates expected installment count for all frequencies and tenures', () => {
    // Monthly: exactly durationMonths
    expect(getExpectedInstallmentCount('monthly', 12)).toBe(12);
    expect(getExpectedInstallmentCount('monthly', 24)).toBe(24);
    expect(getExpectedInstallmentCount('monthly', 36)).toBe(36);
    expect(getExpectedInstallmentCount('monthly', 60)).toBe(60);
    expect(getExpectedInstallmentCount('monthly', 120)).toBe(120);

    // Quarterly: durationMonths / 3
    expect(getExpectedInstallmentCount('quarterly', 12)).toBe(4);
    expect(getExpectedInstallmentCount('quarterly', 24)).toBe(8);

    // Weekly: (durationMonths * 52) / 12
    expect(getExpectedInstallmentCount('weekly', 12)).toBe(52);

    // Daily: 180 for 6 months
    expect(getExpectedInstallmentCount('daily', 6)).toBe(180);
    expect(getExpectedInstallmentCount('daily', 12)).toBe(360);
  });

  it('verifies that adding 12 months creates a maturity date strictly after the 12th installment', () => {
    const firstDue = '2026-10-16';
    const maturity = addMonths(firstDue, 12);
    expect(maturity).toBe('2027-10-16');

    // 12 monthly installments: Month 0 to Month 11
    const finalInstalmentDue = addMonths(firstDue, 11);
    expect(finalInstalmentDue).toBe('2027-09-16');
    expect(finalInstalmentDue < maturity).toBe(true);
  });
});
