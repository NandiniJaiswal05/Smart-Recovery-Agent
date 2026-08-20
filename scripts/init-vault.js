/**
 * scripts/init-vault.js
 * Initializes HashiCorp Vault Transit engine and encryption key.
 */

require('dotenv').config();
const axios = require('axios');

const VAULT_ADDR = process.env.VAULT_ADDR || 'http://127.0.0.1:8200';
const VAULT_TOKEN = process.env.VAULT_TOKEN || 'root_dev_token_2026';
const TRANSIT_KEY_NAME = process.env.VAULT_TRANSIT_KEY || 'payment-key';

const headers = { 'X-Vault-Token': VAULT_TOKEN };

async function initVault() {
  console.log('==================================================');
  console.log('Initializing HashiCorp Vault Transit Engine');
  console.log(`Vault Address: ${VAULT_ADDR}`);
  console.log(`Transit Key:   ${TRANSIT_KEY_NAME}`);
  console.log('==================================================');

  console.log('[1/4] Checking Vault health...');
  await axios.get(`${VAULT_ADDR}/v1/sys/health`, { timeout: 5000 });
  console.log('Vault server is accessible.');

  console.log("[2/4] Enabling 'transit' secrets engine...");
  try {
    await axios.post(`${VAULT_ADDR}/v1/sys/mounts/transit`, { type: 'transit' }, { headers });
    console.log('Transit secrets engine mounted successfully.');
  } catch (error) {
    const status = error.response?.status;
    if (status === 400) {
      console.log('Transit secrets engine already mounted at /transit.');
    } else {
      throw error;
    }
  }

  console.log(`[3/4] Provisioning transit encryption key '${TRANSIT_KEY_NAME}'...`);
  try {
    await axios.post(
      `${VAULT_ADDR}/v1/transit/keys/${TRANSIT_KEY_NAME}`,
      { type: 'aes256-gcm96' },
      { headers }
    );
    console.log(`Key '${TRANSIT_KEY_NAME}' created successfully.`);
  } catch (error) {
    const status = error.response?.status;
    if (status === 400) {
      console.log(`Key '${TRANSIT_KEY_NAME}' already exists.`);
    } else {
      throw error;
    }
  }

  console.log('[4/4] Verifying transit key...');
  const keyInfo = await axios.get(`${VAULT_ADDR}/v1/transit/keys/${TRANSIT_KEY_NAME}`, { headers });
  if (keyInfo.data?.data?.name) {
    console.log(`Successfully verified Transit Key '${TRANSIT_KEY_NAME}'.`);
  }

  console.log('==================================================');
  console.log('Vault Transit Engine Configuration Complete!');
  console.log('==================================================');
}

initVault().catch((error) => {
  const message = error.response?.data || error.message || String(error);
  console.error('[Vault Init] Failed:', message);

  if (error.code === 'ECONNREFUSED' || String(message).includes('ECONNREFUSED')) {
    console.error('\nHashiCorp Vault is not running at', VAULT_ADDR);
    console.error('Choose one:\n');
    console.error('  1. Start Vault:  docker compose up -d vault vault-init');
    console.error('  2. Dev mock mode: set VAULT_MODE=mock in .env (skips real Vault)\n');
    console.error('Run  npm run check-services  to diagnose all dependencies.\n');
  }

  process.exit(1);
});
