/**
 * src/workers/recovery.scheduler.js
 * Polls recovery_schedules and enqueues due jobs into BullMQ.
 */

require('dotenv').config();
const { query } = require('../../config/database');
const { scheduleRecoveryJob } = require('./recovery.queue');

const POLL_INTERVAL_MS = parseInt(process.env.SCHEDULER_POLL_INTERVAL_MS || '60000', 10);

async function pollDueRecoveries() {
  const result = await query(
    `SELECT rs.id, rs.transaction_id, rs.retry_scheduled_at, t.status AS tx_status
     FROM recovery_schedules rs
     JOIN transactions t ON t.transaction_id = rs.transaction_id
     WHERE rs.status = 'SCHEDULED'
       AND rs.retry_scheduled_at <= CURRENT_TIMESTAMP
       AND t.status NOT IN ('SUCCESS', 'AUTHORIZED', 'HARD_DECLINED')
     ORDER BY rs.retry_scheduled_at ASC
     LIMIT 50`
  );

  for (const row of result.rows) {
    const delayMs = Math.max(0, new Date(row.retry_scheduled_at).getTime() - Date.now());

    await query(
      `UPDATE recovery_schedules SET status = 'PROCESSING' WHERE id = $1 AND status = 'SCHEDULED'`,
      [row.id]
    );

    await scheduleRecoveryJob(row.transaction_id, delayMs);
    console.log(
      `[Recovery Scheduler] Enqueued recovery for Tx ${row.transaction_id} (delay: ${delayMs}ms)`
    );
  }

  if (result.rows.length > 0) {
    console.log(`[Recovery Scheduler] Processed ${result.rows.length} due recovery schedule(s).`);
  }
}

async function startScheduler() {
  console.log(`[Recovery Scheduler] Starting (poll every ${POLL_INTERVAL_MS}ms)...`);

  const tick = async () => {
    try {
      await pollDueRecoveries();
    } catch (error) {
      console.error('[Recovery Scheduler] Poll error:', error.message);
    }
  };

  await tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

if (require.main === module) {
  startScheduler().catch((error) => {
    console.error('[Recovery Scheduler] Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { pollDueRecoveries, startScheduler };
