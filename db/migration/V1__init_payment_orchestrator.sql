-- V1__init_payment_orchestrator.sql
-- Base Schema, Triggers, and Cryptographic SHA-256 Audit Chain

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. TRANSACTIONS TABLE
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id VARCHAR(64) NOT NULL,
    transaction_id VARCHAR(64) UNIQUE NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    primary_acquirer VARCHAR(32) NOT NULL,
    current_acquirer VARCHAR(32) NOT NULL,
    vault_cipher_key TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. IDEMPOTENCY KEYS TABLE
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key VARCHAR(128) PRIMARY KEY, -- Formatted as merchant_id:idempotency_key
    merchant_id VARCHAR(64) NOT NULL,
    request_path VARCHAR(255) NOT NULL,
    request_hash VARCHAR(64) NOT NULL, -- SHA-256 hash of payload
    response_code INTEGER,
    response_body JSONB,
    locked_until TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. RECOVERY SCHEDULES TABLE
CREATE TABLE IF NOT EXISTS recovery_schedules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id VARCHAR(64) NOT NULL REFERENCES transactions(transaction_id) ON DELETE CASCADE,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    status VARCHAR(32) NOT NULL DEFAULT 'SCHEDULED', -- SCHEDULED, EXECUTED, EXPIRED
    retry_scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. TRANSACTION AUDIT LOGS (Cryptographic Ledger Chain)
CREATE TABLE IF NOT EXISTS transaction_audit_logs (
    sequence_id BIGSERIAL PRIMARY KEY,
    transaction_id VARCHAR(64) NOT NULL,
    previous_status VARCHAR(32),
    new_status VARCHAR(32) NOT NULL,
    previous_hash VARCHAR(64) NOT NULL,
    current_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- INDEXES
CREATE INDEX IF NOT EXISTS idx_transactions_merchant ON transactions(merchant_id);
CREATE INDEX IF NOT EXISTS idx_recovery_due ON recovery_schedules(status, retry_scheduled_at);
CREATE INDEX IF NOT EXISTS idx_audit_tx ON transaction_audit_logs(transaction_id);

-- 5. TRIGGER FUNCTION FOR CRYPTOGRAPHIC SHA-256 AUDIT CHAINING
CREATE OR REPLACE FUNCTION fn_audit_transaction_state_change()
RETURNS TRIGGER AS $$
DECLARE
    v_prev_hash VARCHAR(64);
    v_curr_hash VARCHAR(64);
    v_prev_status VARCHAR(32);
BEGIN
    -- Determine previous status
    IF (TG_OP = 'INSERT') THEN
        v_prev_status := 'NONE';
    ELSE
        v_prev_status := OLD.status;
    END IF;

    -- Fetch latest current_hash for this transaction (or initial seed)
    SELECT current_hash INTO v_prev_hash
    FROM transaction_audit_logs
    WHERE transaction_id = NEW.transaction_id
    ORDER BY sequence_id DESC
    LIMIT 1;

    IF v_prev_hash IS NULL THEN
        v_prev_hash := '0000000000000000000000000000000000000000000000000000000000000000';
    END IF;

    -- Compute SHA-256 digest: SHA256(prev_hash + tx_id + new_status + timestamp)
    v_curr_hash := encode(
        digest(
            v_prev_hash || NEW.transaction_id || NEW.status || CURRENT_TIMESTAMP::text,
            'sha256'
        ),
        'hex'
    );

    -- Insert into audit log
    INSERT INTO transaction_audit_logs (
        transaction_id,
        previous_status,
        new_status,
        previous_hash,
        current_hash
    ) VALUES (
        NEW.transaction_id,
        v_prev_status,
        NEW.status,
        v_prev_hash,
        v_curr_hash
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- BIND TRIGGER TO TRANSACTIONS TABLE
DROP TRIGGER IF EXISTS trg_audit_tx_state ON transactions;
CREATE TRIGGER trg_audit_tx_state
AFTER INSERT OR UPDATE OF status ON transactions
FOR EACH ROW
EXECUTE FUNCTION fn_audit_transaction_state_change();