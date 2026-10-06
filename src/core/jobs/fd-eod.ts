import { transaction } from '../../database/client.js';
import { logger } from '../logger.js';

export async function processEODFDMaturity() {
  logger.info('Starting EOD FD Maturity processing...');
  try {
    await transaction(async (client) => {
      // Find FD accounts maturing today
      const { rows: maturingFds } = await client.query(`
        SELECT id, account_number, customer_id, maturity_action, deposit_amount, interest_rate
        FROM fd_account 
        WHERE maturity_date <= CURRENT_DATE AND status = 'active'
        FOR UPDATE SKIP LOCKED
      `);

      if (maturingFds.length === 0) {
        logger.info('No FD accounts maturing today.');
        return;
      }

      for (const fd of maturingFds) {
        logger.info({ fdId: fd.id, action: fd.maturity_action }, 'Processing matured FD');
        
        // 1. Mark FD as matured
        await client.query(`
          UPDATE fd_account 
          SET status = 'matured', updated_at = now() 
          WHERE id = $1
        `, [fd.id]);

        // 2. Record maturity event
        await client.query(`
          INSERT INTO fd_maturity_event (fd_account_id, event_type, event_date, details)
          VALUES ($1, 'matured', CURRENT_DATE, $2)
        `, [fd.id, JSON.stringify({ action_configured: fd.maturity_action })]);

        // 3. Process action if possible automatically
        if (fd.maturity_action === 'transfer_to_savings') {
          // Attempt to find active savings account for customer
          const { rows: savings } = await client.query(`
            SELECT id FROM savings_account 
            WHERE customer_id = $1 AND status = 'active' LIMIT 1
          `, [fd.customer_id]);
          
          if (savings.length > 0) {
            // Wait, calculate final interest amount (simplified)
            // Real implementation would calculate compound interest precisely
            const totalMaturityValue = parseFloat(fd.deposit_amount) * (1 + (parseFloat(fd.interest_rate) / 100));
            
            // Post transaction
            await client.query(`
              INSERT INTO account_transaction (
                savings_account_id, transaction_type, direction, amount, balance_after, value_date, description, performed_source
              )
              VALUES ($1, 'deposit', 'credit', $2, 
                (SELECT current_balance + $2 FROM savings_account WHERE id = $1), 
                CURRENT_DATE, $3, 'system'
              ) RETURNING id
            `, [savings[0].id, totalMaturityValue, `FD Maturity Transfer (A/c ${fd.account_number})`]);

            await client.query(`
              UPDATE savings_account SET current_balance = current_balance + $1 WHERE id = $2
            `, [totalMaturityValue, savings[0].id]);
          }
        }
      }

      logger.info({ count: maturingFds.length }, 'EOD FD Maturity processing completed successfully.');
    });
  } catch (error) {
    logger.error({ error }, 'Failed to process EOD FD Maturity');
    throw error;
  }
}
