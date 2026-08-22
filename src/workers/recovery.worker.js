require('dotenv').config();
const express = require('express');
const { executeRecovery } = require('../services/payment.service');
const { verifyInternalToken } = require('../middleware/security');

const app = express();
app.use(express.json({ limit: '32kb' }));

app.get('/health', (_, res) => res.json({ status: 'UP', service: 'recovery-worker' }));

app.post('/internal/recovery', verifyInternalToken, async (req, res) => {
  const { transactionId, attemptNumber } = req.body || {};
  if (!transactionId || !Number.isInteger(Number(attemptNumber))) {
    return res.status(400).json({ error: 'transactionId and integer attemptNumber are required' });
  }

  try {
    const result = await executeRecovery(transactionId, Number(attemptNumber));
    res.status(200).json(result);
  } catch (err) {
    console.error('[RecoveryWorker]', err);
    res.status(500).json({ error: 'Recovery task failed' });
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`Recovery worker listening on ${port}`));
