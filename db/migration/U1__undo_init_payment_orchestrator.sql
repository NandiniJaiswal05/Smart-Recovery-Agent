-- U1__undo_init_payment_orchestrator.sql
-- Rollback Script for V1__init_payment_orchestrator.sql

-- 1. DROP TRIGGERS
DROP TRIGGER IF EXISTS trg_audit_tx_state ON transactions;

-- 2. DROP TRIGGER FUNCTIONS
DROP FUNCTION IF EXISTS fn_audit_transaction_state_change();

-- 3. DROP INDEXES
DROP INDEX IF EXISTS idx_audit_tx;
DROP INDEX IF EXISTS idx_recovery_due;
DROP INDEX IF EXISTS idx_transactions_merchant;

-- 4. DROP TABLES (IN REVERSE DEPENDENCY ORDER)
DROP TABLE IF EXISTS transaction_audit_logs;
DROP TABLE IF EXISTS recovery_schedules;
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS transactions;

-- 5. DROP EXTENSIONS (OPTIONAL / CLEANUP)
-- DROP EXTENSION IF EXISTS "pgcrypto";
-- DROP EXTENSION IF EXISTS "uuid-ossp";