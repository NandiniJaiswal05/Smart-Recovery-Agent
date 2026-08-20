# Razorpay Smart Recovery Agent

A deployable prototype for automated recovery of failed/soft-declined payments.

## What is included

- Express payment API
- PostgreSQL transaction + recovery state
- BullMQ/Render Key Value delayed retry queue
- Python FastAPI routing agent
- AI routing through Anthropic with deterministic fallback
- Recovery worker that asks the agent for the next acquirer
- HMAC recovery links
- Hash-chained transaction audit log
- Render-ready dashboard at `/`
- Render Blueprint (`render.yaml`) for the API, agent, worker, Key Value and Postgres

## Important production boundary

This repository is a prototype/demo architecture. Do **not** send or store real PAN/CVC data in the current demo adapters. For a production payment recovery system, use gateway-issued payment method tokens/network tokens and the gateway's official retry/recovery APIs. Replace the local/mock Vault mode with a managed secret/tokenization architecture before handling live customer payment credentials.

The bundled gateway adapters simulate outcomes by default. Live gateway integrations are intentionally not enabled.

## Local

```bash
npm install
docker compose up -d postgres redis vault
npm run migrate
npm start
```

Open `http://localhost:3000`.

## Render

The included `render.yaml` creates:

1. `smart-recovery-api` — public Express web service + dashboard
2. `smart-recovery-agent` — private FastAPI service
3. `smart-recovery-worker` — BullMQ background worker
4. `smart-recovery-kv` — Render Key Value
5. `smart-recovery-db` — Render Postgres

Create the Blueprint from Render, supply `ANTHROPIC_API_KEY` if you want Claude routing, and set the generated `HMAC_SECRET` / `VAULT_MOCK_SECRET` values.

The API runs migrations through Render's pre-deploy command.

### Why there is no Render Vault service

Render does not provide HashiCorp Vault as a native managed resource. The Blueprint therefore uses the application's `VAULT_MODE=mock` only for a prototype deployment. For production, replace this with a real managed Vault/KMS/tokenization solution.

## Recovery flow

Payment -> soft decline -> recovery schedule -> BullMQ delayed job -> AI routing decision -> secondary acquirer -> success or another scheduled retry -> hard decline after max attempts.

The dashboard is an operational prototype and should be protected with authentication/SSO before production exposure.
