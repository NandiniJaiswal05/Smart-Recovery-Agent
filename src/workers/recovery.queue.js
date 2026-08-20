// BullMQ Queue Setup & Producer
/**
 * src/workers/recovery.queue.js
 * BullMQ Queue Producer Configuration for Payment Recovery Jobs
 */

const { Queue } = require('bullmq');
const { REDIS_CONFIG } = require('../../config/redis');

const RECOVERY_QUEUE_NAME = 'payment-recovery-queue';

// Instantiate the recovery queue attached to Redis connection
const recoveryQueue = new Queue(RECOVERY_QUEUE_NAME, {
  connection: REDIS_CONFIG,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000, // 5s initial delay between retries
    },
    removeOnComplete: {
      age: 24 * 3600, // Keep completed jobs for 24 hours
      count: 1000,
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // Keep failed jobs for 7 days
    },
  },
});

/**
 * Schedules a transaction recovery job
 * @param {string} transactionId
 * @param {number} delayMs Delay in milliseconds before job execution
 */
async function scheduleRecoveryJob(transactionId, delayMs = 0) {
  const jobId = `recovery:${transactionId}`;

  const existingJob = await recoveryQueue.getJob(jobId);
  if (existingJob) {
    const state = await existingJob.getState();

    if (state === 'delayed') {
      // A delayed job already exists. If the caller wants it to run sooner
      // (e.g. delayMs <= 0 for the customer-triggered "recover now" link),
      // promote it to the waiting list instead of silently skipping it -
      // otherwise callers requesting an immediate retry get no-op'd while
      // still being told "scheduled immediately".
      if (delayMs <= 0) {
        await existingJob.promote();
        console.log(`[Recovery Queue] Promoted delayed job ${jobId} to run immediately`);
        return existingJob;
      }
      console.log(`[Recovery Queue] Job ${jobId} already delayed, skipping duplicate enqueue`);
      return existingJob;
    }

    if (['waiting', 'active'].includes(state)) {
      console.log(
        `[Recovery Queue] Job ${jobId} already ${state}, skipping duplicate enqueue`
      );
      return existingJob;
    }

    await existingJob.remove();
  }

  const job = await recoveryQueue.add(
    'process-recovery',
    { transactionId, scheduledAt: new Date().toISOString() },
    {
      jobId, // Unique ID prevents duplicate jobs for same transaction
      delay: delayMs,
    }
  );

  console.log(
    `[Recovery Queue] Enqueued job ${job.id} for Tx ${transactionId} (Delay: ${delayMs}ms)`
  );

  return job;
}

module.exports = {
  RECOVERY_QUEUE_NAME,
  recoveryQueue,
  scheduleRecoveryJob,
};