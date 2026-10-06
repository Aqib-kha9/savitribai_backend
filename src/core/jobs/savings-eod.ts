import { transaction } from '../../database/client.js';
import { logger } from '../logger.js';

export async function processEODSavingsSnapshot() {
  logger.info('Starting EOD Savings Balance Snapshot...');
  try {
    await transaction(async (client) => {
      // Logic for capturing daily EOD balances for quarterly interest calculation
      const result = await client.query(`
        INSERT INTO savings_daily_balance (savings_account_id, balance, snapshot_date)
        SELECT id, current_balance, CURRENT_DATE
        FROM savings_account
        WHERE status = 'active'
        ON CONFLICT (savings_account_id, snapshot_date) 
        DO UPDATE SET balance = EXCLUDED.balance, created_at = now()
      `);
      
      logger.info({ count: result.rowCount }, 'Savings balances snapshotted for interest calculation.');
    });
    logger.info('EOD Savings Snapshot completed successfully.');
  } catch (error) {
    logger.error({ error }, 'Failed to snapshot savings balances');
    throw error;
  }
}
