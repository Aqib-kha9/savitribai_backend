import { eodQueue } from './queue.js';
import { 
  JOB_EOD_LOAN_INTEREST, 
  JOB_EOD_RD_PENALTY, 
  JOB_EOD_FD_MATURITY, 
  JOB_EOD_SAVINGS_BALANCE 
} from './worker.js';
import { logger } from '../logger.js';

/**
 * Schedules all End of Day (EOD) financial calculations to run at midnight.
 */
export async function scheduleEODJobs() {
  try {
    // We use BullMQ's repeatable jobs with cron syntax
    // 55 23 * * * means 23:55 (11:55 PM) every day
    const cronExpression = '55 23 * * *';

    await eodQueue.upsertJobScheduler('repeat-savings-balance', {
      pattern: cronExpression,
    }, {
      name: JOB_EOD_SAVINGS_BALANCE,
    });

    await eodQueue.upsertJobScheduler('repeat-loan-interest', {
      pattern: cronExpression,
    }, {
      name: JOB_EOD_LOAN_INTEREST,
    });

    await eodQueue.upsertJobScheduler('repeat-rd-penalty', {
      pattern: cronExpression,
    }, {
      name: JOB_EOD_RD_PENALTY,
    });

    await eodQueue.upsertJobScheduler('repeat-fd-maturity', {
      pattern: cronExpression,
    }, {
      name: JOB_EOD_FD_MATURITY,
    });

    logger.info('Successfully scheduled EOD BullMQ jobs.');
  } catch (error) {
    logger.error({ error }, 'Failed to schedule EOD BullMQ jobs.');
  }
}
