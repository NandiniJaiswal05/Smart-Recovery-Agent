/**
 * scripts/verify-audit-chain.js
 * Verifies cryptographic SHA-256 hash chain integrity of transaction_audit_logs.
 */

require('dotenv').config();
const crypto = require('crypto');
const { pool } = require('../config/database');

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Recalculates expected current_hash using the same formula as fn_audit_transaction_state_change.
 * SHA256(previous_hash + transaction_id + new_status + timestamp_text)
 *
 * IMPORTANT: `timestampText` must be the raw text Postgres produced for
 * CURRENT_TIMESTAMP::text at insert time (fetched via `created_at::text` in the
 * query below), NOT a value reconstructed from a JS Date. node-postgres parses
 * timestamptz columns into JS Date objects, which only carry millisecond
 * precision, while Postgres's own `::text` cast keeps microsecond precision and
 * trims trailing zeros. Re-deriving the string from a Date therefore almost
 * never matches what the trigger actually hashed, which used to make every
 * record look tampered with.
 */
function computeAuditHash(previousHash, transactionId, newStatus, timestampText) {
  const payload = `${previousHash}${transactionId}${newStatus}${timestampText}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

async function verifyAuditChain(targetTransactionId) {
  console.log('\n==================================================');
  console.log(' Starting Audit Ledger Verification');
  console.log(
    targetTransactionId
      ? ` Target Transaction ID: ${targetTransactionId}`
      : ' Scope: All Audit Records in Database'
  );
  console.log('==================================================\n');

  const client = await pool.connect();

  try {
    let queryText = `
      SELECT sequence_id, transaction_id, previous_status, new_status, previous_hash, current_hash,
             created_at, created_at::text AS created_at_text
      FROM transaction_audit_logs
    `;
    const params = [];

    if (targetTransactionId) {
      queryText += ' WHERE transaction_id = $1';
      params.push(targetTransactionId);
    }

    queryText += ' ORDER BY sequence_id ASC';

    const res = await client.query(queryText, params);
    const records = res.rows;

    if (records.length === 0) {
      console.log('No audit log entries found to verify.');
      return;
    }

    console.log(`Found ${records.length} audit record(s) to verify.\n`);

    let verifiedCount = 0;
    let corruptedCount = 0;
    const chainStateByTx = {};

    for (const row of records) {
      const { sequence_id, transaction_id, new_status, previous_hash, current_hash, created_at_text } =
        row;

      if (chainStateByTx[transaction_id]) {
        const expectedPrevHash = chainStateByTx[transaction_id];
        if (previous_hash !== expectedPrevHash) {
          console.error(`[BROKEN CHAIN] Sequence #${sequence_id} (Tx: ${transaction_id})`);
          console.error(`   Expected Previous Hash: ${expectedPrevHash}`);
          console.error(`   Actual Previous Hash:   ${previous_hash}`);
          corruptedCount++;
          continue;
        }
      } else if (previous_hash !== GENESIS_HASH) {
        console.error(
          `[GENESIS MISMATCH] Sequence #${sequence_id} (Tx: ${transaction_id}) initial previous_hash is not zeroed out.`
        );
        corruptedCount++;
        continue;
      }

      const expectedHash = computeAuditHash(previous_hash, transaction_id, new_status, created_at_text);
      if (expectedHash !== current_hash) {
        console.error(`[HASH MISMATCH] Sequence #${sequence_id} (Tx: ${transaction_id})`);
        console.error(`   Expected: ${expectedHash}`);
        console.error(`   Actual:   ${current_hash}`);
        corruptedCount++;
        continue;
      }

      const isHex64 = /^[a-f0-9]{64}$/i.test(current_hash);
      if (!isHex64) {
        console.error(
          `[INVALID HASH FORMAT] Sequence #${sequence_id} hash is not a valid 64-char hex string.`
        );
        corruptedCount++;
        continue;
      }

      chainStateByTx[transaction_id] = current_hash;
      verifiedCount++;

      console.log(
        `[VERIFIED] Seq #${sequence_id} | Tx: ${transaction_id} | State: -> ${new_status} | Hash: ${current_hash.slice(0, 16)}...`
      );
    }

    console.log('\n==================================================');
    console.log(' Verification Summary');
    console.log(` Total Evaluated: ${records.length}`);
    console.log(` Valid Records:   ${verifiedCount}`);
    console.log(` Tampered/Broken: ${corruptedCount}`);
    console.log('==================================================\n');

    if (corruptedCount > 0) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('Error executing audit verification:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

const targetTx = process.argv[2];
verifyAuditChain(targetTx);
