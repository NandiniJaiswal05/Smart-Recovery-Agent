// DB-backed Idempotency Lock Middleware
/**
 * src/middleware/idempotency.js
 * Database-backed Idempotency Key Lock Middleware
 */

const crypto = require('crypto');
const { pool } = require('../../config/database');

/**
 * Creates an idempotency middleware configured with a custom Lock TTL.
 * @param {number} lockTTLSeconds Lock duration in seconds (default: 120s)
 */
function idempotencyMiddleware(lockTTLSeconds = 120) {
  return async (req, res, next) => {
    // Only enforce idempotency for state-changing HTTP methods
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
      return next();
    }

    const idempotencyKey = req.headers['idempotency-key'];
    const merchantId = req.headers['x-merchant-id'];

    if (!idempotencyKey || !merchantId) {
      return res.status(400).json({
        error: 'Missing required headers: Idempotency-Key and X-Merchant-ID',
      });
    }

    // Compute request payload SHA-256 hash
    const payloadHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(req.body || {}))
      .digest('hex');

    const formattedKey = `${merchantId}:${idempotencyKey}`;
    const lockedUntil = new Date(Date.now() + lockTTLSeconds * 1000);

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Acquire lock / check existing execution record
      const selectQuery = `
        SELECT request_hash, response_code, response_body, locked_until 
        FROM idempotency_keys 
        WHERE key = $1 
        FOR UPDATE
      `;
      const existing = await client.query(selectQuery, [formattedKey]);

      if (existing.rows.length > 0) {
        const record = existing.rows[0];

        // 1. Mismatched payload for identical key
        if (record.request_hash !== payloadHash) {
          await client.query('ROLLBACK');
          return res.status(422).json({
            error: 'Idempotency Key reused with modified request payload',
          });
        }

        // 2. Previously completed request -> return cached response
        if (record.response_body !== null) {
          await client.query('COMMIT');
          return res.status(record.response_code).json(record.response_body);
        }

        // 3. Concurrent request in progress
        if (new Date(record.locked_until) > new Date()) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'Concurrent request currently in progress for this Idempotency Key',
          });
        }
      }

      // Upsert lock record
      const upsertQuery = `
        INSERT INTO idempotency_keys (key, merchant_id, request_path, request_hash, locked_until)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (key) DO UPDATE 
        SET locked_until = EXCLUDED.locked_until, request_hash = EXCLUDED.request_hash;
      `;
      await client.query(upsertQuery, [
        formattedKey,
        merchantId,
        req.originalUrl,
        payloadHash,
        lockedUntil,
      ]);

      await client.query('COMMIT');

      // Intercept res.json to cache final payload and release response lock
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        pool
          .query(
            `UPDATE idempotency_keys 
             SET response_code = $1, response_body = $2 
             WHERE key = $3`,
            [res.statusCode, body, formattedKey]
          )
          .catch((err) =>
            console.error('[Idempotency Error] Failed to persist response body:', err)
          );

        return originalJson(body);
      };

      next();
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Idempotency Error] Processing lock failure:', error);
      res.status(500).json({ error: 'Internal Server Idempotency Lock Error' });
    } finally {
      client.release();
    }
  };
}

module.exports = idempotencyMiddleware;