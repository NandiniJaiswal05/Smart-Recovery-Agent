/**
 * config/vault.js
 * HashiCorp Vault Transit Engine integration with optional local mock mode for dev.
 */

const crypto = require('crypto');
const axios = require('axios');

const VAULT_MODE = (process.env.VAULT_MODE || 'vault').toLowerCase();
const VAULT_ADDR = process.env.VAULT_ADDR || 'http://127.0.0.1:8200';
const VAULT_TOKEN = process.env.VAULT_TOKEN;
const TRANSIT_KEY_NAME = process.env.VAULT_TRANSIT_KEY || 'payment-key';
const MOCK_KEY = crypto
  .createHash('sha256')
  .update(process.env.VAULT_MOCK_SECRET || 'dev-only-vault-mock-key')
  .digest();

function assertVaultToken() {
  if (VAULT_MODE === 'mock') return;
  if (!VAULT_TOKEN) {
    throw new Error('VAULT_TOKEN environment variable is required (or set VAULT_MODE=mock for local dev)');
  }
}

function mockEncrypt(payload) {
  const stringData = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MOCK_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(stringData, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `mock:v1:${Buffer.concat([iv, tag, encrypted]).toString('base64url')}`;
}

function mockDecrypt(ciphertext) {
  if (!ciphertext.startsWith('mock:v1:')) {
    throw new Error('Invalid mock ciphertext format');
  }
  const data = Buffer.from(ciphertext.slice('mock:v1:'.length), 'base64url');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', MOCK_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

class VaultService {
  static async encrypt(payload) {
    assertVaultToken();

    if (VAULT_MODE === 'mock') {
      return mockEncrypt(payload);
    }

    try {
      const stringData = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
      const base64Data = Buffer.from(stringData).toString('base64');

      const response = await axios.post(
        `${VAULT_ADDR}/v1/transit/encrypt/${TRANSIT_KEY_NAME}`,
        { plaintext: base64Data },
        { headers: { 'X-Vault-Token': VAULT_TOKEN } }
      );

      return response.data.data.ciphertext;
    } catch (error) {
      console.error('[Vault Error] Encryption failed:', error.response?.data || error.message);
      throw new Error('Vault Transit Encryption Error');
    }
  }

  static async decrypt(ciphertext) {
    assertVaultToken();

    if (VAULT_MODE === 'mock') {
      return mockDecrypt(ciphertext);
    }

    try {
      const response = await axios.post(
        `${VAULT_ADDR}/v1/transit/decrypt/${TRANSIT_KEY_NAME}`,
        { ciphertext },
        { headers: { 'X-Vault-Token': VAULT_TOKEN } }
      );

      return Buffer.from(response.data.data.plaintext, 'base64').toString('utf-8');
    } catch (error) {
      console.error('[Vault Error] Decryption failed:', error.response?.data || error.message);
      throw new Error('Vault Transit Decryption Error');
    }
  }
}

module.exports = VaultService;
