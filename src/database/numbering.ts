import type { PoolClient } from 'pg';
import { istBusinessDate } from '../core/time.js';
import { InternalError } from '../core/errors.js';

/**
 * Number sequence allocator (spec §4).
 *
 * Central `number_sequence` table with per-entity-type counters, allocated
 * atomically (single UPDATE ... RETURNING holds the row lock) inside the
 * caller's DB transaction. Sequences with a reset period (daily/monthly)
 * restart at 1 when the IST business period changes.
 *
 * Cancelled numbers are never re-issued by default
 * (allow_cancelled_reuse = false — audit-safe default).
 */
export interface AllocatedNumber {
  entityType: string;
  value: number;
  formatted: string;
}

// Type alias (not interface) so it satisfies pg's QueryResultRow index signature.
type SequenceRow = {
  allocated_value: string;
  prefix: string;
  padding: number;
};

function currentPeriod(resetPeriod: 'daily' | 'monthly' | 'yearly', businessDate: string): string {
  switch (resetPeriod) {
    case 'daily':
      return businessDate;
    case 'monthly':
      return businessDate.slice(0, 7);
    case 'yearly':
      return businessDate.slice(0, 4);
  }
}

/**
 * Allocates the next number for `entityType`. MUST be called inside a
 * database transaction that also creates the record using the number,
 * so the allocation commits or rolls back together with the record.
 */
export async function allocateSequence(client: PoolClient, entityType: string): Promise<AllocatedNumber> {
  const businessDate = istBusinessDate();
  const dailyPeriod = currentPeriod('daily', businessDate);
  const monthlyPeriod = currentPeriod('monthly', businessDate);
  const yearlyPeriod = currentPeriod('yearly', businessDate);

  const { rows } = await client.query<SequenceRow>(
    `
    UPDATE number_sequence
       SET next_value = CASE
             WHEN reset_period = 'daily'   AND current_period IS DISTINCT FROM $2 THEN 2
             WHEN reset_period = 'monthly' AND current_period IS DISTINCT FROM $3 THEN 2
             WHEN reset_period = 'yearly'  AND current_period IS DISTINCT FROM $4 THEN 2
             ELSE next_value + 1
           END,
           current_period = CASE
             WHEN reset_period = 'daily'   THEN $2
             WHEN reset_period = 'monthly' THEN $3
             WHEN reset_period = 'yearly'  THEN $4
             ELSE current_period
           END
     WHERE entity_type = $1
     RETURNING next_value - 1 AS allocated_value, prefix, padding
    `,
    [entityType, dailyPeriod, monthlyPeriod, yearlyPeriod],
  );

  const row = rows[0];
  if (!row) {
    throw new InternalError(`number sequence not configured for entity type: ${entityType}`);
  }

  const value = Number(row.allocated_value);
  return {
    entityType,
    value,
    formatted: formatNumber(row.prefix, value, row.padding),
  };
}

export function formatNumber(prefix: string, value: number, padding: number): string {
  return `${prefix}${String(value).padStart(padding, '0')}`;
}

/**
 * Customer numbers follow the "Name 0001" scheme (spec §4): the first word of
 * the registered name (upper-cased, alphanumeric) + a 4-digit sequence.
 */
export function customerNumberFrom(fullName: string, sequence: AllocatedNumber): string {
  const namePart = (fullName.trim().split(/\s+/)[0] ?? 'CUST')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return `${namePart} ${sequence.formatted}`;
}
