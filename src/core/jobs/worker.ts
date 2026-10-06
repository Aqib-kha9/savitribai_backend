import { Worker, Job } from 'bullmq';
import { redisConnection } from './queue.js';
import { logger } from '../logger.js';
import { checkIdempotency, generateEODKey } from './idempotency.js';
import { processEODLoanInterest } from './loan-eod.js';
import { processEODRDPenalty } from './rd-eod.js';
import { processEODFDMaturity } from './fd-eod.js';
import { processEODSavingsSnapshot } from './savings-eod.js';

// Job names
export const JOB_EOD_LOAN_INTEREST = 'eod-loan-interest';
export const JOB_EOD_RD_PENALTY = 'eod-rd-penalty';
export const JOB_EOD_FD_MATURITY = 'eod-fd-maturity';
export const JOB_EOD_SAVINGS_BALANCE = 'eod-savings-balance';

export const eodWorker = new Worker(
  'eod-calculations-queue',
  async (job: Job) => {
    logger.info({ jobId: job.id, jobName: job.name }, 'Processing EOD job');
    
    const today = new Date();
    const jobKey = generateEODKey(job.name, today);

    // Idempotency check: if already processed today, skip it.
    const shouldProcess = await checkIdempotency(jobKey);
    if (!shouldProcess) {
      logger.info({ jobKey }, 'Job already processed for today. Skipping.');
      return;
    }

    switch (job.name) {
      case JOB_EOD_LOAN_INTEREST:
        await processEODLoanInterest();
        break;
      case JOB_EOD_RD_PENALTY:
        await processEODRDPenalty();
        break;
      case JOB_EOD_FD_MATURITY:
        await processEODFDMaturity();
        break;
      case JOB_EOD_SAVINGS_BALANCE:
        await processEODSavingsSnapshot();
        break;
      default:
        logger.warn({ jobName: job.name }, 'Unknown job name');
    }
  },
  {
    connection: redisConnection,
    concurrency: 1, // Ensure sequential processing per worker for financial safety
  }
);

eodWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, jobName: job.name }, 'EOD job completed successfully');
});

eodWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, jobName: job?.name, err }, 'EOD job failed');
});
