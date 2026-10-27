process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
process.env.JWT_ACCESS_SECRET = '01234567890123456789012345678901';

import { describe, it, expect, beforeAll } from 'vitest';

describe('Sync Service Unit Tests', () => {
  let evaluateOfflineLate: typeof import('./sync.service.js').evaluateOfflineLate;

  beforeAll(async () => {
    const mod = await import('./sync.service.js');
    evaluateOfflineLate = mod.evaluateOfflineLate;
  });

  it('correctly evaluates offline late status', () => {
    const today = new Date();
    // Captured now -> not late
    expect(evaluateOfflineLate('2026-10-27', today, today)).toBe(false);

    // Captured 40 hours ago -> late (since limit is 36 hours)
    const fortyHoursAgo = new Date(today.getTime() - 40 * 3600 * 1000);
    expect(evaluateOfflineLate('2026-10-25', fortyHoursAgo, today)).toBe(true);
  });
});
