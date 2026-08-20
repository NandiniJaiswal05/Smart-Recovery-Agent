// 36-Hour Soft-Decline Background Worker
/**
 * src/workers/recovery.worker.js
 * BullMQ Background Worker to Process Soft-Decline Retry Operations
 */

require('dotenv').config();
const { Worker } = require('bullmq');
const { REDIS_CONFIG } = require('../../config/redis');
const { RECOVERY_QUEUE_NAME, scheduleRecoveryJob } = require('./recovery.queue');
const { query } = require('../../config/database');
const GatewayService = require('../services/gateway.service');
const VaultService = require('../services/vault.service');
const { getRoutingDecision } = require('../services/agent.client');

const RECOVERY_DELAY_MS = parseInt(process.env.RECOVERY_DELAY_MS || '1800000', 10); // 30 min

/**
 * Processor function executed for each queued recovery job
 */
async function processRecoveryJob(job) {
  const { transactionId } = job.data;
  console.log(`[Recovery Worker] Starting processing for Tx: ${transactionId} (Job ${job.id})`);

  // 1. Fetch transaction and recovery schedule state
  const txResult = await query(
    `SELECT t.id, t.merchant_id, t.transaction_id, t.amount, t.currency, 
            t.status, t.primary_acquirer, t.current_acquirer, t.vault_cipher_key,
            r.id as schedule_id, r.attempt_count, r.max_attempts, r.status as schedule_status
     FROM transactions t
     JOIN recovery_schedules r ON t.transaction_id = r.transaction_id
     WHERE t.transaction_id = $1
       AND r.status IN ('SCHEDULED', 'PROCESSING')`,
    [transactionId]
  );

  if (txResult.rows.length === 0) {
    throw new Error(`Transaction ${transactionId} or recovery schedule not found`);
  }

  const tx = txResult.rows[0];

  // Skip if transaction already resolved or max attempts reached
  if (tx.status === 'SUCCESS' || tx.status === 'AUTHORIZED') {
    console.log(`[Recovery Worker] Tx ${transactionId} already successful. Terminating job.`);
    return { status: 'SKIPPED_ALREADY_SUCCESS' };
  }

  if (tx.attempt_count >= tx.max_attempts) {
    console.log(`[Recovery Worker] Tx ${transactionId} exceeded max attempts.`);
    await query(`UPDATE recovery_schedules SET status = 'EXPIRED' WHERE id = $1`, [
      tx.schedule_id,
    ]);
    return { status: 'EXPIRED' };
  }

  await query(`UPDATE recovery_schedules SET status = 'PROCESSING' WHERE id = $1`, [
    tx.schedule_id,
  ]);
  // Ask the recovery agent for the next-best acquirer instead of always
  // hard-switching between two gateways. The agent has a deterministic
  // rule-based fallback when the AI service is unavailable.
  let cardPayload = {};
  try {
    cardPayload = await VaultService.decryptCardPayload(tx.vault_cipher_key);
  } catch (error) {
    console.warn('[Recovery Worker] Could not decrypt card metadata for agent routing:', error.message);
  }

  const routingDecision = await getRoutingDecision({
    merchant_id: tx.merchant_id,
    amount: tx.amount,
    currency: tx.currency,
    card_brand: cardPayload?.brand || cardPayload?.card_brand || 'UNKNOWN',
    country: cardPayload?.country || 'IN',
    decline_code: cardPayload?.decline_code || 'SOFT_DECLINED',
    previous_acquirer: tx.current_acquirer,
    attempt_count: tx.attempt_count,
  });

  const fallbackAcquirer = (routingDecision.selected_acquirer || (
    tx.primary_acquirer === 'RAZORPAY' ? 'STRIPE' : 'RAZORPAY'
  )).toUpperCase();

  const agentDelayMs = Math.max(
    0,
    Number(routingDecision.retry_delay_seconds || 0) * 1000
  );

  // Increment attempt counter
  const newAttemptCount = tx.attempt_count + 1;
  await query(
    `UPDATE recovery_schedules SET attempt_count = $1 WHERE id = $2`,
    [newAttemptCount, tx.schedule_id]
  );

  console.log(
    `[Recovery Worker] Execution Attempt ${newAttemptCount}/${tx.max_attempts} via ${fallbackAcquirer}`
  );

  // 3. Attempt payment charge via secondary gateway
  const result = await GatewayService.executeCharge(tx, fallbackAcquirer);

  // 4. Handle retry result & state machine transitions
  if (result.status === 'AUTHORIZED' || result.status === 'SUCCESS') {
    await query(
      `UPDATE transactions 
       SET status = 'SUCCESS', current_acquirer = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE transaction_id = $2`,
      [fallbackAcquirer, transactionId]
    );

    await query(`UPDATE recovery_schedules SET status = 'EXECUTED' WHERE id = $1`, [
      tx.schedule_id,
    ]);

    console.log(`[Recovery Worker] Recovery SUCCESSFUL for Tx ${transactionId}`);
    return { status: 'RECOVERY_SUCCESS', gateway: fallbackAcquirer };
  }

  // Soft declined again — schedule next retry if within limit
  if (newAttemptCount < tx.max_attempts) {
    console.log(`[Recovery Worker] Recovery failed. Scheduling subsequent attempt...`);

    const nextRetryAt = new Date(Date.now() + (agentDelayMs || RECOVERY_DELAY_MS)).toISOString();

    await query(
      `UPDATE transactions 
       SET current_acquirer = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE transaction_id = $2`,
      [fallbackAcquirer, transactionId]
    );

    // Put the schedule row back into SCHEDULED state with a new retry time, and
    // actually enqueue the next delayed BullMQ job. Without this, recovery
    // silently stops after a single retry regardless of max_attempts.
    await query(
      `UPDATE recovery_schedules
       SET status = 'SCHEDULED', retry_scheduled_at = $1::timestamptz
       WHERE id = $2`,
      [nextRetryAt, tx.schedule_id]
    );

    await scheduleRecoveryJob(transactionId, agentDelayMs || RECOVERY_DELAY_MS);
  } else {
    // Max attempts exhausted -> mark as HARD_DECLINED
    await query(
      `UPDATE transactions 
       SET status = 'HARD_DECLINED', current_acquirer = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE transaction_id = $2`,
      [fallbackAcquirer, transactionId]
    );

    await query(`UPDATE recovery_schedules SET status = 'EXPIRED' WHERE id = $1`, [
      tx.schedule_id,
    ]);

    console.log(`[Recovery Worker] Max retries exhausted for Tx ${transactionId}. Marked HARD_DECLINED.`);
  }

  return {
    status: result.status,
    attempt: newAttemptCount,
    agent: {
      selected_acquirer: fallbackAcquirer,
      confidence_score: routingDecision.confidence_score,
      reasoning: routingDecision.reasoning,
    },
  };
}

// Instantiate BullMQ Worker
const recoveryWorker = new Worker(RECOVERY_QUEUE_NAME, processRecoveryJob, {
  connection: REDIS_CONFIG,
  concurrency: 5,
});

recoveryWorker.on('completed', (job, returnvalue) => {
  console.log(`[Recovery Worker] Job ${job.id} completed. Result:`, returnvalue);
});

recoveryWorker.on('failed', async (job, err) => {
  console.error(`[Recovery Worker] Job ${job?.id} failed with error:`, err.message);

  if (job?.data?.transactionId) {
    try {
      await query(
        `UPDATE recovery_schedules
         SET status = 'SCHEDULED'
         WHERE transaction_id = $1 AND status = 'PROCESSING'`,
        [job.data.transactionId]
      );
    } catch (resetError) {
      console.error('[Recovery Worker] Failed to reset schedule status:', resetError.message);
    }
  }
});

console.log('[Recovery Worker] Payment Recovery Worker active and watching queue...');

module.exports = recoveryWorker;