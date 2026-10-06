import { transaction } from '../../database/client.js';
import { logger } from '../logger.js';
import { isSunday, istBusinessDate } from '../time.js'; 

export async function processEODLoanInterest() {
  logger.info('Starting EOD Loan Processing...');

  try {
    await transaction(async (client) => {
      const today = new Date();
      const todayStr = istBusinessDate(today);

      // 1. Shift instalments due on Sunday to Monday
      if (isSunday(todayStr)) {
        logger.info('Today is Sunday, shifting due dates to Monday...');
        await client.query(`
          UPDATE loan_instalment 
          SET due_date = due_date + INTERVAL '1 day' 
          WHERE due_date = CURRENT_DATE AND status = 'due'
        `);
      }

      // 2. Lock active/overdue loans safely and find overdue instalments
      const { rows: overdueInstalments } = await client.query(`
        SELECT 
          l.id AS loan_id,
          p.penalty_config,
          i.id AS instalment_id,
          i.expected_amount,
          i.due_date
        FROM loan_instalment i
        JOIN loan l ON i.loan_id = l.id
        JOIN loan_product p ON l.product_id = p.id
        WHERE l.status IN ('active', 'overdue')
          AND i.status = 'due'
          AND i.due_date < CURRENT_DATE
        FOR UPDATE OF l SKIP LOCKED
      `);

      logger.info({ count: overdueInstalments.length }, 'Found overdue loan instalments for EOD penalty');

      for (const row of overdueInstalments) {
        let penaltyAmount = 0;
        const config = row.penalty_config || {};

        // 3. Dynamic penalty calculation based on product JSONB config
        if (config.type === 'percentage' && typeof config.value === 'number') {
          penaltyAmount = parseFloat(row.expected_amount) * (config.value / 100);
        } else if (config.type === 'fixed' && typeof config.amount === 'number') {
          penaltyAmount = config.amount;
        } else {
          // Default fallback
          penaltyAmount = 100.00;
        }

        // Apply penalty to the instalment
        await client.query(`
          UPDATE loan_instalment 
          SET 
            penalty_component = penalty_component + $1,
            expected_amount = expected_amount + $1,
            status = 'overdue', 
            updated_at = now() 
          WHERE id = $2
        `, [penaltyAmount, row.instalment_id]);

        // Mark the loan itself as overdue
        await client.query(`
          UPDATE loan 
          SET status = 'overdue', updated_at = now() 
          WHERE id = $1
        `, [row.loan_id]);
      }
    });
    logger.info('EOD Loan Processing completed successfully.');
  } catch (error) {
    logger.error({ error }, 'Failed to process EOD loans');
    throw error;
  }
}
