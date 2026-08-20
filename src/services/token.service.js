/**
 * src/services/token.service.js
 * HMAC-SHA256 ephemeral token generator for secure recovery links.
 */

const crypto = require('crypto');

const HMAC_SECRET = process.env.HMAC_SECRET || 'super-secret-hmac-key-2026';

class TokenService {
  static generateRecoveryToken(transactionId, ttlMinutes = 10) {
    const expiresAt = Date.now() + ttlMinutes * 60 * 1000;
    const payload = JSON.stringify({ tx: transactionId, exp: expiresAt });

    const base64Payload = Buffer.from(payload).toString('base64url');
    const signature = crypto
      .createHmac('sha256', HMAC_SECRET)
      .update(base64Payload)
      .digest('base64url');

    return `${base64Payload}.${signature}`;
  }

  static verifyRecoveryToken(token) {
    if (!token || !token.includes('.')) {
      throw new Error('Invalid token structure');
    }

    const [base64Payload, signature] = token.split('.');

    const expectedSignature = crypto
      .createHmac('sha256', HMAC_SECRET)
      .update(base64Payload)
      .digest('base64url');

    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (sigBuffer.length !== expectedBuffer.length) {
      throw new Error('Token signature verification failed');
    }

    const isSignatureValid = crypto.timingSafeEqual(sigBuffer, expectedBuffer);
    if (!isSignatureValid) {
      throw new Error('Token signature verification failed');
    }

    const payloadJson = Buffer.from(base64Payload, 'base64url').toString('utf-8');
    const payload = JSON.parse(payloadJson);

    if (Date.now() > payload.exp) {
      throw new Error('Recovery token has expired');
    }

    return payload;
  }
}

module.exports = TokenService;
