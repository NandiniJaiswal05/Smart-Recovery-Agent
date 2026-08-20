/**
 * scripts/migrate.js
 * Applies SQL migrations from db/migration/ in version order.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migration');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(128) PRIMARY KEY,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

async function getAppliedVersions(client) {
  const result = await client.query('SELECT version FROM schema_migrations ORDER BY version');
  return new Set(result.rows.map((row) => row.version));
}

async function runMigrations() {
  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedVersions(client);

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.startsWith('V') && file.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('[Migrate] No migration files found.');
      return;
    }

    for (const file of files) {
      const version = file.replace('.sql', '');
      if (applied.has(version)) {
        console.log(`[Migrate] Skipping already applied: ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`[Migrate] Applying ${file}...`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        console.log(`[Migrate] Applied ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    console.log('[Migrate] All migrations up to date.');
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch((error) => {
  const code = error.code || '';
  const message = error.message || String(error);
  console.error('[Migrate] Failed:', message || code || 'Unknown database error');

  if (code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
    console.error(
      `\nPostgreSQL is not running at ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}.`
    );
    console.error('Start it first, then retry:\n');
    console.error('  docker compose up -d postgres redis vault   (requires Docker Desktop)');
    console.error('  npm run check-services                        (diagnose all services)\n');
  }

  process.exit(1);
});
