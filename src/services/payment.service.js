/**
 * src/services/payment.service.js
 * Core payment orchestration: charge, status updates, and recovery scheduling.
 */

const { query } = require('../../config/database');
const VaultService = require('./vault.service');
const GatewayService = require('./gateway.service');
const { scheduleRecoveryJob } = require('../workers/recovery.queue');

const RECOVERY_DELAY_MS = parseInt(process.env.RECOVERY_DELAY_MS || '1800000', 10); // 30 min
const MAX_RECOVERY_ATTEMPTS = parseInt(process.env.MAX_RECOVERY_ATTEMPTS || '3', 10);

/**
 * Maps gateway result status to transaction status.
 */
function mapGatewayStatus(gatewayStatus) {
  switch (gatewayStatus) {
    case 'AUTHORIZED':
    case 'SUCCESS':
      return 'SUCCESS';
    case 'SOFT_DECLINED':
      return 'SOFT_DECLINED';
    case 'HARD_DECLINED':
      return 'HARD_DECLINED';
    default:
      return 'FAILED';
  }
}

/**
 * Creates a transaction, charges via primary acquirer, and schedules recovery if needed.
 */
async function createAndProcessPayment({ merchantId, transactionId, amount, currency, primaryAcquirer, cardPayload }) {
  const vaultCipherKey = await VaultService.encryptCardPayload(cardPayload);

  const insertResult = await query(
    `INSERT INTO transactions (
       merchant_id, transaction_id, amount, currency, status,
       primary_acquirer, current_acquirer, vault_cipher_key
     ) VALUES ($1, $2, $3, $4, 'PENDING', $5, $5, $6)
     RETURNING id, merchant_id, transaction_id, amount, currency, status,
               primary_acquirer, current_acquirer, vault_cipher_key, created_at`,
    [merchantId, transactionId, amount, currency || 'INR', primaryAcquirer, vaultCipherKey]
  );

  const transaction = insertResult.rows[0];

  let chargeResult;
  try {
    chargeResult = await GatewayService.executeCharge(transaction, primaryAcquirer);
  } catch (err) {
    // The row already exists as PENDING at this point. If the gateway call
    // itself blows up (network error, decrypt failure, unsupported acquirer,
    // etc.) rather than returning a normal decline, don't leave the
    // transaction stuck at PENDING forever with no recovery ever scheduled -
    // mark it FAILED so it's visible and the caller gets a clear error.
    console.error(`[PaymentService] Charge execution failed for Tx ${transactionId}:`, err.message);
    await query(
      `UPDATE transactions
       SET status = 'FAILED', updated_at = CURRENT_TIMESTAMP
       WHERE transaction_id = $1`,
      [transactionId]
    );
    throw err;
  }

  const finalStatus = mapGatewayStatus(chargeResult.status);

  const updatedResult = await query(
    `UPDATE transactions
     SET status = $1, current_acquirer = $2, updated_at = CURRENT_TIMESTAMP
     WHERE transaction_id = $3
     RETURNING id, merchant_id, transaction_id, amount, currency, status,
               primary_acquirer, current_acquirer, created_at, updated_at`,
    [finalStatus, chargeResult.gateway || primaryAcquirer, transactionId]
  );

  const updatedTransaction = updatedResult.rows[0];
  let recoverySchedule = null;

  if (finalStatus === 'SOFT_DECLINED') {
    recoverySchedule = await scheduleRecoveryForTransaction(transactionId);
  }

  return {
    transaction: updatedTransaction,
    gateway_result: {
      status: chargeResult.status,
      gateway: chargeResult.gateway,
      gateway_reference: chargeResult.gatewayReference,
    },
    recovery_schedule: recoverySchedule,
  };
}

/**
 * Updates transaction status and optionally schedules recovery.
 */
async function updateTransactionStatus(transactionId, status, scheduleRecovery = true) {
  const result = await query(
    `UPDATE transactions
     SET status = $1, updated_at = CURRENT_TIMESTAMP
     WHERE transaction_id = $2
     RETURNING id, transaction_id, status, current_acquirer, updated_at`,
    [status, transactionId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  let recoverySchedule = null;

  if (status === 'SOFT_DECLINED' && scheduleRecovery) {
    recoverySchedule = await scheduleRecoveryForTransaction(transactionId);
  }

  return {
    transaction: result.rows[0],
    recovery_schedule: recoverySchedule,
  };
}

/**
 * Inserts a recovery schedule row and enqueues a BullMQ job.
 */
async function scheduleRecoveryForTransaction(transactionId, delayMs = RECOVERY_DELAY_MS) {
  const existing = await query(
    `SELECT id, status FROM recovery_schedules
     WHERE transaction_id = $1 AND status IN ('SCHEDULED', 'PROCESSING')
     ORDER BY created_at DESC LIMIT 1`,
    [transactionId]
  );

  if (existing.rows.length > 0) {
    const schedule = existing.rows[0];
    await scheduleRecoveryJob(transactionId, delayMs);
    return schedule;
  }

  const retryAt = new Date(Date.now() + delayMs).toISOString();

  const scheduleResult = await query(
    `INSERT INTO recovery_schedules (
       transaction_id, attempt_count, max_attempts, status, retry_scheduled_at
     ) VALUES ($1, 0, $2, 'SCHEDULED', $3::timestamptz)
     RETURNING id, attempt_count, max_attempts, status, retry_scheduled_at`,
    [transactionId, MAX_RECOVERY_ATTEMPTS, retryAt]
  );

  await scheduleRecoveryJob(transactionId, delayMs);
  return scheduleResult.rows[0];
}

/**
 * Fetches transaction with audit chain.
 */
async function getTransactionDetails(transactionId) {
  const txResult = await query(
    `SELECT id, merchant_id, transaction_id, amount, currency, status,
            primary_acquirer, current_acquirer, created_at, updated_at
     FROM transactions WHERE transaction_id = $1`,
    [transactionId]
  );

  if (txResult.rows.length === 0) {
    return null;
  }

  const auditLogs = await query(
    `SELECT sequence_id, previous_status, new_status, previous_hash, current_hash, created_at
     FROM transaction_audit_logs
     WHERE transaction_id = $1
     ORDER BY sequence_id ASC`,
    [transactionId]
  );

  const recoveryResult = await query(
    `SELECT id, attempt_count, max_attempts, status, retry_scheduled_at, created_at
     FROM recovery_schedules
     WHERE transaction_id = $1
     ORDER BY created_at DESC`,
    [transactionId]
  );

  return {
    transaction: txResult.rows[0],
    audit_chain: auditLogs.rows,
    recovery_schedules: recoveryResult.rows,
  };
}

module.exports = {
  createAndProcessPayment,
  updateTransactionStatus,
  scheduleRecoveryForTransaction,
  getTransactionDetails,
  mapGatewayStatus,
};
