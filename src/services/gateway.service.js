/**
 * src/services/gateway.service.js
 * Multi-acquirer gateway abstraction with AI-assisted routing.
 */

const VaultService = require('./vault.service');
const { getRoutingDecision } = require('./agent.client');

class GatewayService {
  /**
   * Resolves the best acquirer for a transaction using the AI agent (with fallback).
   */
  static async resolveAcquirer(transaction, cardPayload, preferredAcquirer) {
    if (preferredAcquirer) {
      return preferredAcquirer.toUpperCase();
    }

    const decision = await getRoutingDecision({
      merchant_id: transaction.merchant_id,
      amount: transaction.amount,
      currency: transaction.currency,
      card_brand: cardPayload?.brand || cardPayload?.card_brand || 'UNKNOWN',
      country: cardPayload?.country || 'IN',
      decline_code: cardPayload?.decline_code || 'NONE',
    });

    return (decision.selected_acquirer || 'RAZORPAY').toUpperCase();
  }

  /**
   * Executes a charge against a primary or fallback acquirer gateway.
   */
  static async executeCharge(transaction, targetAcquirer, cardPayloadOverride = null) {
    let cardPayload = cardPayloadOverride;

    if (!cardPayload) {
      try {
        // vault.service.js's decryptCardPayload already parses JSON payloads
        // internally, so no need to JSON.parse here.
        cardPayload = await VaultService.decryptCardPayload(transaction.vault_cipher_key);
      } catch (err) {
        console.error('[GatewayService] Card decryption failed:', err.message);
        throw new Error('Failed to decrypt card details for gateway routing');
      }
    }

    const acquirer = await this.resolveAcquirer(transaction, cardPayload, targetAcquirer);
    console.log(`[GatewayService] Routing Tx ${transaction.transaction_id} to ${acquirer}`);

    switch (acquirer) {
      case 'RAZORPAY':
        return this._processRazorpay(transaction, cardPayload);
      case 'STRIPE':
        return this._processStripe(transaction, cardPayload);
      case 'PAYPAL':
        return this._processPayPal(transaction, cardPayload);
      default:
        throw new Error(`Unsupported acquirer gateway: ${acquirer}`);
    }
  }

  static async _processRazorpay(transaction, cardPayload) {
    const razorpayKey = process.env.RAZORPAY_KEY_ID;
    const razorpaySecret = process.env.RAZORPAY_KEY_SECRET;

    if (razorpayKey && razorpaySecret && process.env.RAZORPAY_MODE === 'live') {
      return this._callRazorpayApi(transaction, cardPayload, razorpayKey, razorpaySecret);
    }

    const isSuccess = this._simulateOutcome(transaction.transaction_id, 'RAZORPAY', 0.6);
    if (isSuccess) {
      return {
        status: 'AUTHORIZED',
        gateway: 'RAZORPAY',
        gatewayReference: `rzp_pay_${Date.now()}`,
        rawResponse: { code: '200', message: 'Payment authorized' },
      };
    }

    return {
      status: 'SOFT_DECLINED',
      gateway: 'RAZORPAY',
      gatewayReference: `rzp_err_${Date.now()}`,
      rawResponse: { code: 'BAD_REQUEST_ERROR', reason: 'INSUFFICIENT_FUNDS' },
    };
  }

  static async _processStripe(transaction, cardPayload) {
    const stripeKey = process.env.STRIPE_SECRET_KEY;

    if (stripeKey && process.env.STRIPE_MODE === 'live') {
      return this._callStripeApi(transaction, cardPayload, stripeKey);
    }

    const isSuccess = this._simulateOutcome(transaction.transaction_id, 'STRIPE', 0.75);
    if (isSuccess) {
      return {
        status: 'AUTHORIZED',
        gateway: 'STRIPE',
        gatewayReference: `ch_stripe_${Date.now()}`,
        rawResponse: { code: 'succeeded', status: 'paid' },
      };
    }

    return {
      status: 'HARD_DECLINED',
      gateway: 'STRIPE',
      gatewayReference: `ch_err_${Date.now()}`,
      rawResponse: { code: 'card_declined', decline_code: 'generic_decline' },
    };
  }

  static async _processPayPal(transaction, cardPayload) {
    const isSuccess = this._simulateOutcome(transaction.transaction_id, 'PAYPAL', 0.7);
    if (isSuccess) {
      return {
        status: 'AUTHORIZED',
        gateway: 'PAYPAL',
        gatewayReference: `pp_${Date.now()}`,
        rawResponse: { status: 'COMPLETED' },
      };
    }

    return {
      status: 'SOFT_DECLINED',
      gateway: 'PAYPAL',
      gatewayReference: `pp_err_${Date.now()}`,
      rawResponse: { status: 'DECLINED' },
    };
  }

  /**
   * Deterministic simulation for demo/test mode (not random).
   */
  static _simulateOutcome(transactionId, gateway, successRate) {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(`${transactionId}:${gateway}`).digest('hex');
    const bucket = parseInt(hash.slice(0, 8), 16) / 0xffffffff;
    return bucket < successRate;
  }

  static async _callRazorpayApi(transaction, cardPayload, keyId, keySecret) {
    const axios = require('axios');
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

    const response = await axios.post(
      'https://api.razorpay.com/v1/payments',
      {
        amount: Math.round(Number(transaction.amount) * 100),
        currency: transaction.currency || 'INR',
        method: 'card',
        card: cardPayload,
      },
      { headers: { Authorization: `Basic ${auth}` }, timeout: 15000 }
    );

    return {
      status: response.data.status === 'captured' ? 'AUTHORIZED' : 'PENDING',
      gateway: 'RAZORPAY',
      gatewayReference: response.data.id,
      rawResponse: response.data,
    };
  }

  static async _callStripeApi(transaction, cardPayload, secretKey) {
    const axios = require('axios');

    const response = await axios.post(
      'https://api.stripe.com/v1/payment_intents',
      new URLSearchParams({
        amount: String(Math.round(Number(transaction.amount) * 100)),
        currency: (transaction.currency || 'usd').toLowerCase(),
        'payment_method_data[type]': 'card',
        'payment_method_data[card][number]': cardPayload.number,
        'payment_method_data[card][exp_month]': String(cardPayload.exp_month),
        'payment_method_data[card][exp_year]': String(cardPayload.exp_year),
        'payment_method_data[card][cvc]': String(cardPayload.cvc),
        confirm: 'true',
      }),
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 15000,
      }
    );

    return {
      status: response.data.status === 'succeeded' ? 'AUTHORIZED' : 'PENDING',
      gateway: 'STRIPE',
      gatewayReference: response.data.id,
      rawResponse: response.data,
    };
  }
}

module.exports = GatewayService;
