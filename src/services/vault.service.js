// Vault Transit Encryption/Decryption API
/**
 * src/services/vault.service.js
 * Business Logic Abstraction Layer for HashiCorp Vault Operations
 */

const VaultClient = require('../../config/vault');

class VaultService {
  /**
   * Encrypts payment token or card payload using Vault Transit Engine
   * @param {Object|string} payload Card details or payment payload
   * @returns {Promise<string>} Vault ciphertext string ('vault:v1:...')
   */
  static async encryptCardPayload(payload) {
    if (!payload) {
      throw new Error('Payload is required for Vault encryption');
    }

    try {
      const ciphertext = await VaultClient.encrypt(payload);
      return ciphertext;
    } catch (error) {
      console.error('[VaultService] Failed to encrypt card payload:', error.message);
      throw error;
    }
  }

  /**
   * Decrypts Vault ciphertext back to original JSON/string payload
   * @param {string} ciphertext Vault formatted ciphertext
   * @returns {Promise<Object|string>} Decrypted payment payload
   */
  static async decryptCardPayload(ciphertext) {
    // Real HashiCorp Vault Transit ciphertext is prefixed 'vault:v1:...'; the
    // local dev mock mode (VAULT_MODE=mock) produces 'mock:v1:...' ciphertext.
    // Only checking for 'vault:' rejected every ciphertext produced in the
    // default dev configuration.
    if (!ciphertext || !/^(vault|mock):/.test(ciphertext)) {
      throw new Error('Invalid or missing Vault ciphertext format');
    }

    try {
      const decryptedString = await VaultClient.decrypt(ciphertext);
      
      // Attempt to parse back to JSON if payload was structured
      try {
        return JSON.parse(decryptedString);
      } catch {
        return decryptedString;
      }
    } catch (error) {
      console.error('[VaultService] Failed to decrypt card payload:', error.message);
      throw error;
    }
  }
}

module.exports = VaultService;