require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const crypto = require('crypto');

const { query } = require('../config/database');
const idempotency = require('./middleware/idempotency');
const { rateLimit, requireMerchantApiKey } = require('./middleware/security');
const errorHandler = require('./middleware/errorHandler');
const { createAndProcessPayment, getTransactionDetails } = require('./services/payment.service');
const {
  verifyRazorpaySignature, verifyStripeSignature, recordWebhook, securityEvent
} = require('./services/webhook.security');

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || false }));
app.use(rateLimit);

// Express 4 doesn't catch rejected promises from async route handlers on its
// own - an unhandled rejection here means the request just hangs instead of
// getting a clean error response. Wrapping routes with this forwards any
// thrown/rejected error to the errorHandler middleware at the bottom.
const wrapAsync = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/health', (_, res) => res.json({
  status: 'UP',
  service: 'smart-recovery-api',
  mode: process.env.DEMO_MODE !== 'false' ? 'TEST/DEMO' : 'LIVE_DISABLED_BY_DEFAULT',
}));

// Webhook routes must use raw bodies for signature verification.
app.post('/webhooks/razorpay', express.raw({ type: 'application/json', limit: '1mb' }), wrapAsync(async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  let body = req.body.toString('utf8');
  let payload;
  try { payload = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const eventId = req.headers['x-razorpay-event-id'] || payload.id;
  const valid = verifyRazorpaySignature(body, signature);

  if (!valid) {
    await securityEvent('INVALID_RAZORPAY_SIGNATURE', 'HIGH', { event_id: eventId });
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const record = await recordWebhook('RAZORPAY', eventId, true, body);
  if (!record.firstSeen) return res.status(200).json({ received: true, duplicate: true });

  await query(`UPDATE webhook_events SET status='PROCESSED',processed_at=CURRENT_TIMESTAMP WHERE provider='RAZORPAY' AND provider_event_id=$1`, [eventId || `hash:${record.payloadHash}`]);
  return res.status(200).json({ received: true });
}));

app.post('/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), wrapAsync(async (req, res) => {
  const signature = req.headers['stripe-signature'];
  const body = req.body.toString('utf8');
  let payload;
  try { payload = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const eventId = payload.id;
  const valid = verifyStripeSignature(body, signature);

  if (!valid) {
    await securityEvent('INVALID_STRIPE_SIGNATURE', 'HIGH', { event_id: eventId });
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const record = await recordWebhook('STRIPE', eventId, true, body);
  if (!record.firstSeen) return res.status(200).json({ received: true, duplicate: true });

  await query(`UPDATE webhook_events SET status='PROCESSED',processed_at=CURRENT_TIMESTAMP WHERE provider='STRIPE' AND provider_event_id=$1`, [eventId]);
  return res.status(200).json({ received: true });
}));

app.use(express.json({ limit: '100kb' }));
app.use(express.static('public'));

app.use('/api/v1', requireMerchantApiKey);
app.use('/api/v1', idempotency);

app.post('/api/v1/payments', async (req, res) => {
  try {
    const { transaction_id, amount, currency, primary_acquirer } = req.body || {};
    const merchantId = req.headers['x-merchant-id'];

    if (!transaction_id || !amount || !primary_acquirer) {
      return res.status(400).json({ error: 'transaction_id, amount and primary_acquirer are required' });
    }
    if (Number(amount) <= 0) return res.status(400).json({ error: 'amount must be positive' });
    if (!['RAZORPAY','STRIPE'].includes(String(primary_acquirer).toUpperCase())) {
      return res.status(400).json({ error: 'primary_acquirer must be RAZORPAY or STRIPE' });
    }

    const result = await createAndProcessPayment({
      merchantId, transactionId: transaction_id, amount,
      currency: String(currency || 'INR').toUpperCase(),
      primaryAcquirer: String(primary_acquirer).toUpperCase(),
    });
    res.status(201).json(result);
  } catch (err) {
    console.error('[PaymentAPI]', err);
    res.status(500).json({ error: 'Payment processing failed' });
  }
});

app.get('/api/v1/payments/:id', wrapAsync(async (req, res) => {
  const result = await getTransactionDetails(req.params.id);
  if (!result) return res.status(404).json({ error: 'Transaction not found' });
  res.json(result);
}));

app.get('/api/v1/dashboard/summary', wrapAsync(async (_, res) => {
  const [counts, value, transactions, security] = await Promise.all([
    query(`SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER(WHERE status='SUCCESS')::int AS recovered,
      COUNT(*) FILTER(WHERE status='SOFT_DECLINED')::int AS at_risk,
      COUNT(*) FILTER(WHERE status='HARD_DECLINED')::int AS hard_declined
      FROM transactions`),
    query(`SELECT
      COALESCE(SUM(amount) FILTER(WHERE status='SUCCESS'),0)::numeric AS recovered_value,
      COALESCE(SUM(amount) FILTER(WHERE status='SOFT_DECLINED'),0)::numeric AS at_risk_value
      FROM transactions`),
    query(`SELECT t.transaction_id,t.amount,t.currency,t.status,t.current_acquirer,t.recovery_attempts,t.max_recovery_attempts,t.created_at,
      rs.retry_scheduled_at
      FROM transactions t
      LEFT JOIN LATERAL (
        SELECT retry_scheduled_at FROM recovery_schedules r WHERE r.transaction_id=t.transaction_id ORDER BY r.created_at DESC LIMIT 1
      ) rs ON TRUE
      ORDER BY t.created_at DESC LIMIT 50`),
    query(`SELECT COUNT(*) FILTER(WHERE severity='HIGH')::int AS high_risk,
      COUNT(*)::int AS total_security_events FROM security_events`)
  ]);

  res.json({
    demo_mode: process.env.DEMO_MODE !== 'false',
    metrics: { ...counts.rows[0], ...value.rows[0], ...security.rows[0] },
    transactions: transactions.rows,
  });
}));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`Smart Recovery API listening on ${port}`));
