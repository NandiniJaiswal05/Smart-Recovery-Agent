/**
 * src/services/agent.client.js
 * HTTP client for the Python AI routing agent service.
 */

const axios = require('axios');

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || 'http://127.0.0.1:8000';
const AGENT_TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT_MS || '5000', 10);

/**
 * Requests an acquirer routing decision from the AI agent.
 * Falls back to rule-based routing when the agent is unavailable.
 */
async function getRoutingDecision(transactionContext) {
  try {
    const response = await axios.post(
      `${AGENT_SERVICE_URL}/route`,
      transactionContext,
      { timeout: AGENT_TIMEOUT_MS }
    );
    return response.data;
  } catch (error) {
    console.warn('[AgentClient] Agent unavailable, using fallback routing:', error.message);
    return fallbackRouting(transactionContext);
  }
}

function fallbackRouting(context) {
  const currency = (context.currency || 'INR').toUpperCase();
  const selectedAcquirer = currency === 'INR' ? 'RAZORPAY' : 'STRIPE';

  return {
    selected_acquirer: selectedAcquirer,
    confidence_score: 0.5,
    reasoning: 'Fallback rule: INR -> RAZORPAY, others -> STRIPE',
    recovery_strategy: 'SMART_RETRY',
    retry_delay_seconds: 300,
  };
}

module.exports = { getRoutingDecision, fallbackRouting };
