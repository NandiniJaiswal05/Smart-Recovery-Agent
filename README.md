# Razorpay Smart Recovery Agent — GCP MVP

Security-first automated recovery agent for failed payments.

## MVP stack

- Razorpay Test Mode
- Stripe Test Mode
- Node.js / Express API
- Python FastAPI recovery agent
- Vertex AI Gemini
- Cloud Run
- Cloud SQL PostgreSQL
- Cloud Tasks
- Secret Manager
- Artifact Registry
- Hash-chained audit log

## Core principle

**Vertex AI proposes. Deterministic security code disposes.**

The LLM cannot:
- change payment amount/currency
- access credentials
- invent payment gateways
- bypass retry limits
- authorize arbitrary actions

The action guard is the final authorization boundary.

## Test-only payment model

The MVP deliberately does not accept or store raw PAN/CVC. Test gateway outcomes are simulated deterministically, while the architecture is ready to be connected to official Razorpay/Stripe test PaymentMethod/token APIs.

This avoids accidentally creating an insecure card-data vault during the MVP.

## Run locally

```bash
npm install
# configure PostgreSQL and .env from .env.example
npm run migrate
npm start
```

For the AI agent:

```bash
cd agent
pip install -r requirements.txt
python server.py
```

## GCP

See `gcp/README.md`.

## Security

Webhook signature verification, replay protection, idempotency, rate limiting, internal worker authentication, action allowlisting, retry limits, and audit/security events are included from the beginning.

## Production boundary

Before live payments:
- use gateway-issued PaymentMethod/token references
- complete gateway/webhook production integration
- use Secret Manager/KMS
- enforce IAM service-to-service authentication
- add merchant/dashboard authentication
- add Cloud Armor/WAF and monitoring
- complete applicable PCI/security/compliance review
