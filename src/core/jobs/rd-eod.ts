import { transaction } from '../../database/client.js';
import { logger } from '../logger.js';

export async function processEODRDPenalty() {
  logger.info('Starting EOD RD Penalty check...');
  try {
    await transaction(async (client) => {
      // Find all due instalments that have crossed their grace period
      const { rows: overdueInstalments } = await client.query(`
        SELECT 
          a.id AS account_id,
          a.instalment_amount,
          i.id AS instalment_id,
          i.due_date,
          s.penalty_config
        FROM rd_instalment i
        JOIN rd_account a ON i.rd_account_id = a.id
        JOIN rd_scheme s ON a.scheme_id = s.id
        WHERE a.status IN ('active', 'overdue')
          AND i.status = 'due'
          AND CURRENT_DATE > (i.due_date + (a.grace_period_months || ' months')::interval)
        FOR UPDATE OF a SKIP LOCKED
      `);

      if (overdueInstalments.length === 0) {
        logger.info('No overdue RD instalments found for penalty processing.');
        return;
      }

      for (const row of overdueInstalments) {
        let penaltyAmount = 0;
        const config = row.penalty_config || {};

        // Dynamic calculation based on JSONB config
        if (config.type === 'percentage' && typeof config.value === 'number') {
          penaltyAmount = parseFloat(row.instalment_amount) * (config.value / 100);
        } else if (config.type === 'fixed' && typeof config.amount === 'number') {
          penaltyAmount = config.amount;
        } else {
          // Fallback to a default if config is malformed or missing (e.g., 50 INR fixed)
          penaltyAmount = 50.00;
        }

        // 1. Insert penalty record
        await client.query(`
          INSERT INTO rd_penalty (rd_account_id, instalment_id, penalty_amount, reason)
          VALUES ($1, $2, $3, $4)
        `, [row.account_id, row.instalment_id, penaltyAmount, 'Missed grace period deadline']);

        // 2. Mark instalment as overdue
        await client.query(`
          UPDATE rd_instalment 
          SET status = 'overdue', updated_at = now() 
          WHERE id = $1
        `, [row.instalment_id]);

        // 3. Mark account as overdue
        await client.query(`
          UPDATE rd_account 
          SET status = 'overdue', updated_at = now() 
          WHERE id = $1
        `, [row.account_id]);
      }

      logger.info({ count: overdueInstalments.length }, 'Processed dynamic RD penalties successfully.');
    });
  } catch (error) {
    logger.error({ error }, 'Failed to process EOD RD Penalties');
    throw error;
  }
}
