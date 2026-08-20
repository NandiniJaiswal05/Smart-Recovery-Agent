# Vault Transit Engine Initialization
#!/usr/bin/env bash
# scripts/init-vault.sh
# Initializes HashiCorp Vault Transit Secrets Engine for Payment Key Management

set -euo pipefail

VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
VAULT_TOKEN="${VAULT_TOKEN:-root_dev_token_2026}"
TRANSIT_KEY_NAME="${VAULT_TRANSIT_KEY:-payment-key}"

echo "=================================================="
echo "Initializing HashiCorp Vault Transit Engine"
echo "Vault Address: ${VAULT_ADDR}"
echo "Transit Key:   ${TRANSIT_KEY_NAME}"
echo "=================================================="

# 1. Check Vault Health
echo "[1/4] Checking Vault cluster health..."
if ! curl -s "${VAULT_ADDR}/v1/sys/health" > /dev/null; then
  echo "Error: Vault server is not accessible at ${VAULT_ADDR}"
  exit 1
fi
echo "Vault server is accessible."

# 2. Enable Transit Engine
echo "[2/4] Enabling 'transit' secrets engine..."
ENABLE_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
  --header "X-Vault-Token: ${VAULT_TOKEN}" \
  --request POST \
  --data '{"type": "transit"}' \
  "${VAULT_ADDR}/v1/sys/mounts/transit")

if [ "$ENABLE_RESPONSE" -eq 200 ] || [ "$ENABLE_RESPONSE" -eq 204 ]; then
  echo "Transit secrets engine mounted successfully."
elif [ "$ENABLE_RESPONSE" -eq 400 ]; then
  echo "Transit secrets engine already mounted at /transit."
else
  echo "Failed to mount transit engine. HTTP status: ${ENABLE_RESPONSE}"
  exit 1
fi

# 3. Create AES-256-GCM Encryption Key
echo "[3/4] Provisioning transit encryption key '${TRANSIT_KEY_NAME}'..."
KEY_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
  --header "X-Vault-Token: ${VAULT_TOKEN}" \
  --request POST \
  --data '{"type": "aes256-gcm96"}' \
  "${VAULT_ADDR}/v1/transit/keys/${TRANSIT_KEY_NAME}")

if [ "$KEY_RESPONSE" -eq 200 ] || [ "$KEY_RESPONSE" -eq 204 ]; then
  echo "Key '${TRANSIT_KEY_NAME}' created or verified successfully."
else
  echo "Failed to create transit key. HTTP status: ${KEY_RESPONSE}"
  exit 1
fi

# 4. Verify Key Status
echo "[4/4] Verifying created transit key configuration..."
KEY_INFO=$(curl -s \
  --header "X-Vault-Token: ${VAULT_TOKEN}" \
  "${VAULT_ADDR}/v1/transit/keys/${TRANSIT_KEY_NAME}")

if echo "$KEY_INFO" | grep -q "${TRANSIT_KEY_NAME}"; then
  echo "Successfully verified Transit Key '${TRANSIT_KEY_NAME}'."
else
  echo "Warning: Vault key response did not contain key details."
fi

echo "=================================================="
echo "Vault Transit Engine Configuration Complete!"
echo "=================================================="