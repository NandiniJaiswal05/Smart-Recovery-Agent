/**
 * src/server.js
 * Express application entry point.
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const Redis = require('ioredis');
const { pool } = require('../config/database');
const { REDIS_CONFIG } = require('../config/redis');
const idempotencyMiddleware = require('./middleware/idempotency');
const errorHandler = require('./middleware/errorHandler');
const paymentController = require('./controllers/payment.controller');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

async function checkDatabase() {
  await pool.query('SELECT 1');
  return 'CONNECTED';
}

async function checkRedis() {
  const redis = new Redis({
    host: REDIS_CONFIG.host,
    port: REDIS_CONFIG.port,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    lazyConnect: true,
  });

  try {
    await redis.connect();
    const pong = await redis.ping();
    return pong === 'PONG' ? 'CONNECTED' : 'DEGRADED';
  } finally {
    redis.disconnect();
  }
}

async function checkVault() {
  if (process.env.VAULT_MODE === 'mock') {
    return 'MOCK';
  }
  const vaultAddr = process.env.VAULT_ADDR || 'http://127.0.0.1:8200';
  const response = await axios.get(`${vaultAddr}/v1/sys/health`, { timeout: 2000 });
  return response.data?.initialized ? 'CONNECTED' : 'UNINITIALIZED';
}

async function checkAgent() {
  const agentUrl = process.env.AGENT_SERVICE_URL || 'http://127.0.0.1:8000';
  const response = await axios.get(`${agentUrl}/health`, { timeout: 2000 });
  return response.data?.status === 'UP' ? 'CONNECTED' : 'DEGRADED';
}

app.get('/health', async (req, res) => {
  const checks = {
    status: 'UP',
    database: 'UNKNOWN',
    redis: 'UNKNOWN',
    vault: 'UNKNOWN',
    agent: 'OPTIONAL',
  };

  try {
    checks.database = await checkDatabase();
  } catch (err) {
    checks.database = err.message;
    checks.status = 'DOWN';
  }

  try {
    checks.redis = await checkRedis();
  } catch (err) {
    checks.redis = err.message;
    checks.status = 'DOWN';
  }

  try {
    checks.vault = await checkVault();
  } catch (err) {
    checks.vault = err.message;
    checks.status = 'DOWN';
  }

  try {
    checks.agent = await checkAgent();
  } catch {
    checks.agent = 'UNAVAILABLE';
  }

  const statusCode = checks.status === 'UP' ? 200 : 503;
  res.status(statusCode).json(checks);
});

const apiRouter = express.Router();

apiRouter.post('/payments', idempotencyMiddleware(120), paymentController.createPayment);
apiRouter.patch('/payments/:transactionId/status', paymentController.updatePaymentStatus);
apiRouter.get('/payments/:transactionId', paymentController.getPaymentDetails);
apiRouter.get('/payments/:transactionId/recovery-link', paymentController.getRecoveryLink);
apiRouter.post('/recovery/:token', paymentController.processRecoveryToken);
apiRouter.get('/dashboard/summary', paymentController.getDashboardSummary);

app.use('/api/v1', apiRouter);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.originalUrl} not found` });
});

app.use(errorHandler);

async function startServer() {
  if (process.env.RUN_MIGRATIONS_ON_START === 'true') {
    const { execSync } = require('child_process');
    execSync('node scripts/migrate.js', { stdio: 'inherit' });
  }

  app.listen(PORT, () => {
    console.log(`[Server] Payment Orchestrator running on port ${PORT}`);
  });
}

if (process.env.NODE_ENV !== 'test') {
  startServer().catch((error) => {
    console.error('[Server] Failed to start:', error.message);
    process.exit(1);
  });
}

module.exports = app;
