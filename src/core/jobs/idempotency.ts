import { PoolClient } from 'pg';
import { query } from '../../database/client.js';

/**
 * Ensures that a given EOD job key has not already been processed.
 * Uses a dedicated table or atomic insert to guarantee idempotency.
 */
export async function checkIdempotency(jobKey: string): Promise<boolean> {
  // We'll create a simple eod_idempotency table if it doesn't exist (only run once)
  await query(`
    CREATE TABLE IF NOT EXISTS eod_idempotency (
      job_key VARCHAR(255) PRIMARY KEY,
      processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

  try {
    const result = await query(
      `INSERT INTO eod_idempotency (job_key) VALUES ($1) ON CONFLICT (job_key) DO NOTHING RETURNING job_key`,
      [jobKey]
    );
    return result.rowCount !== null && result.rowCount > 0;
  } catch (error) {
    return false;
  }
}

/**
 * Returns a deterministic key for an EOD task.
 * e.g., 'eod-loan-interest-2026-10-06'
 */
export function generateEODKey(taskName: string, date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${taskName}-${yyyy}-${mm}-${dd}`;
}
