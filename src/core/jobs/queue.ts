import { Queue, QueueEvents, DefaultJobOptions } from 'bullmq';
import { env } from '../../config/env.js';

export const redisConnection = {
  url: env.redisUrl,
};

const defaultJobOptions: DefaultJobOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 5000,
  },
  removeOnComplete: true,
  removeOnFail: false,
};

export const eodQueue = new Queue('eod-calculations-queue', {
  connection: redisConnection,
  defaultJobOptions,
});

export const eodQueueEvents = new QueueEvents('eod-calculations-queue', {
  connection: redisConnection,
});
