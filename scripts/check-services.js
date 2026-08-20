/**
 * scripts/check-services.js
 * Verifies that required infrastructure services are reachable before setup.
 */

require('dotenv').config();
const net = require('net');
const axios = require('axios');
const Redis = require('ioredis');

const services = {
  postgres: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    label: 'PostgreSQL',
  },
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    label: 'Redis',
  },
  vault: {
    url: process.env.VAULT_ADDR || 'http://127.0.0.1:8200',
    label: 'HashiCorp Vault',
    optional: process.env.VAULT_MODE === 'mock',
  },
  agent: {
    url: process.env.AGENT_SERVICE_URL || 'http://127.0.0.1:8000',
    label: 'AI Routing Agent',
    optional: true,
  },
};

function checkTcpPort(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

async function checkPostgres() {
  const { host, port } = services.postgres;
  return checkTcpPort(host, port);
}

async function checkRedis() {
  const { host, port } = services.redis;
  const redis = new Redis({
    host,
    port,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    lazyConnect: true,
  });

  try {
    await redis.connect();
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

async function checkVault() {
  if (process.env.VAULT_MODE === 'mock') {
    return { ok: true, skipped: true };
  }

  try {
    await axios.get(`${services.vault.url}/v1/sys/health`, { timeout: 3000 });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

async function checkAgent() {
  try {
    const response = await axios.get(`${services.agent.url}/health`, { timeout: 3000 });
    return response.data?.status === 'UP';
  } catch {
    return false;
  }
}

function printHelp() {
  console.log('\nHow to start infrastructure:\n');
  console.log('  Option A (recommended): Install Docker Desktop, then run:');
  console.log('    docker compose up -d postgres redis vault vault-init\n');
  console.log('  Option B: Install services manually on Windows:');
  console.log('    - PostgreSQL 16  -> https://www.postgresql.org/download/windows/');
  console.log('    - Redis (Memurai) -> https://www.memurai.com/');
  console.log('    - Vault           -> https://developer.hashicorp.com/vault/install');
  console.log('      Then run: vault server -dev\n');
  console.log('  Vault mock mode (skip Vault, dev only):');
  console.log('    Set VAULT_MODE=mock in .env\n');
  console.log('After infrastructure is up:');
  console.log('    npm run init-vault   (skip if VAULT_MODE=mock)');
  console.log('    npm run migrate');
  console.log('    npm start\n');
}

async function main() {
  console.log('Checking required services...\n');

  const pgOk = await checkPostgres();
  const redisOk = await checkRedis();
  const vaultResult = await checkVault();
  const agentOk = await checkAgent();

  const rows = [
    {
      name: services.postgres.label,
      target: `${services.postgres.host}:${services.postgres.port}`,
      ok: pgOk,
      required: true,
    },
    {
      name: services.redis.label,
      target: `${services.redis.host}:${services.redis.port}`,
      ok: redisOk,
      required: true,
    },
    {
      name: services.vault.label,
      target: services.vault.url,
      ok: vaultResult.skipped ? true : vaultResult.ok,
      required: !services.vault.optional,
      note: vaultResult.skipped ? 'mock mode' : undefined,
    },
    {
      name: services.agent.label,
      target: services.agent.url,
      ok: agentOk,
      required: false,
    },
  ];

  let allRequiredOk = true;

  for (const row of rows) {
    const status = row.ok ? 'OK' : 'DOWN';
    const req = row.required ? 'required' : 'optional';
    const note = row.note ? ` (${row.note})` : '';
    console.log(`  [${status}] ${row.name} @ ${row.target} (${req})${note}`);
    if (row.required && !row.ok) {
      allRequiredOk = false;
    }
  }

  console.log('');

  if (allRequiredOk) {
    console.log('All required services are reachable. You can run:');
    if (!vaultResult.skipped) {
      console.log('  npm run init-vault');
    }
    console.log('  npm run migrate');
    console.log('  npm start');
    return;
  }

  console.log('Some required services are not running.');
  printHelp();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error('[Check Services] Unexpected error:', error.message);
  process.exit(1);
});
