/**
 * src/controllers/payment.controller.js
 * Request handlers for charges, status updates, and recovery.
 */

const PaymentService = require('../services/payment.service');
const TokenService = require('../services/token.service');

async function createPayment(req, res, next) {
  try {
    const merchantId = req.headers['x-merchant-id'];
    const { transaction_id, amount, currency, primary_acquirer, card_payload } = req.body;

    if (!transaction_id || amount == null || !primary_acquirer || !card_payload) {
      return res.status(400).json({
        error: 'Missing required parameters: transaction_id, amount, primary_acquirer, card_payload',
      });
    }

    if (Number(amount) <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than zero' });
    }

    const result = await PaymentService.createAndProcessPayment({
      merchantId,
      transactionId: transaction_id,
      amount,
      currency,
      primaryAcquirer: primary_acquirer,
      cardPayload: card_payload,
    });

    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Transaction ID already exists' });
    }
    next(error);
  }
}

async function updatePaymentStatus(req, res, next) {
  try {
    const { transactionId } = req.params;
    const { status, schedule_recovery } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Status field is required' });
    }

    const result = await PaymentService.updateTransactionStatus(
      transactionId,
      status,
      schedule_recovery !== false
    );

    if (!result) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
}

async function getPaymentDetails(req, res, next) {
  try {
    const { transactionId } = req.params;
    const details = await PaymentService.getTransactionDetails(transactionId);

    if (!details) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    return res.status(200).json(details);
  } catch (error) {
    next(error);
  }
}

async function getRecoveryLink(req, res, next) {
  try {
    const { transactionId } = req.params;
    const details = await PaymentService.getTransactionDetails(transactionId);

    if (!details) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (!['SOFT_DECLINED', 'PENDING'].includes(details.transaction.status)) {
      return res.status(400).json({
        error: 'Recovery links are only available for soft-declined or pending transactions',
      });
    }

    const token = TokenService.generateRecoveryToken(transactionId);
    const baseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

    return res.status(200).json({
      transaction_id: transactionId,
      recovery_token: token,
      recovery_url: `${baseUrl}/api/v1/recovery/${token}`,
      expires_in_minutes: 10,
    });
  } catch (error) {
    next(error);
  }
}

async function processRecoveryToken(req, res, next) {
  try {
    const { token } = req.params;
    const payload = TokenService.verifyRecoveryToken(token);
    const details = await PaymentService.getTransactionDetails(payload.tx);

    if (!details) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (details.transaction.status === 'SUCCESS') {
      return res.status(200).json({
        message: 'Transaction already recovered successfully',
        transaction: details.transaction,
      });
    }

    const recoverySchedule = await PaymentService.scheduleRecoveryForTransaction(payload.tx, 0);

    return res.status(202).json({
      message: 'Recovery retry scheduled immediately',
      transaction_id: payload.tx,
      recovery_schedule: recoverySchedule,
    });
  } catch (error) {
    if (error.message.includes('token') || error.message.includes('Token')) {
      return res.status(401).json({ error: error.message });
    }
    next(error);
  }
}

async function getDashboardSummary(req, res, next) {
  try {
    const { query } = require('../../config/database');

    const [metrics, transactions] = await Promise.all([
      query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS recovered,
          COUNT(*) FILTER (WHERE status IN ('SOFT_DECLINED','PENDING','FAILED'))::int AS at_risk,
          COUNT(*) FILTER (WHERE status = 'HARD_DECLINED')::int AS hard_declined,
          COALESCE(SUM(amount) FILTER (WHERE status IN ('SOFT_DECLINED','PENDING','FAILED')), 0)::numeric AS at_risk_value,
          COALESCE(SUM(amount) FILTER (WHERE status = 'SUCCESS'), 0)::numeric AS recovered_value
        FROM transactions
      `),
      query(`
        SELECT
          t.transaction_id, t.merchant_id, t.amount, t.currency, t.status,
          t.primary_acquirer, t.current_acquirer, t.created_at, t.updated_at,
          COALESCE(r.attempt_count, 0)::int AS attempt_count,
          COALESCE(r.max_attempts, $1)::int AS max_attempts,
          r.retry_scheduled_at
        FROM transactions t
        LEFT JOIN LATERAL (
          SELECT attempt_count, max_attempts, retry_scheduled_at
          FROM recovery_schedules
          WHERE transaction_id = t.transaction_id
          ORDER BY created_at DESC
          LIMIT 1
        ) r ON true
        ORDER BY t.created_at DESC
        LIMIT 50
      `, [parseInt(process.env.MAX_RECOVERY_ATTEMPTS || '3', 10)]),
    ]);

    return res.json({
      metrics: metrics.rows[0],
      transactions: transactions.rows,
      demo_mode: process.env.RAZORPAY_MODE !== 'live' && process.env.STRIPE_MODE !== 'live',
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createPayment,
  updatePaymentStatus,
  getPaymentDetails,
  getRecoveryLink,
  processRecoveryToken,
  getDashboardSummary,
};
