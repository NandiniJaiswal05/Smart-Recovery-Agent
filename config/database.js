// PostgreSQL pool configuration with Render DATABASE_URL support.
const { Pool } = require('pg');

const poolOptions = {
  max: parseInt(process.env.DB_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};

if (process.env.DATABASE_URL) {
  poolOptions.connectionString = process.env.DATABASE_URL;
  if (process.env.DB_SSL === 'true') {
    poolOptions.ssl = { rejectUnauthorized: false };
  }
} else {
  Object.assign(poolOptions, {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'payment_orchestrator',
    user: process.env.DB_USER || 'orchestrator',
    password: process.env.DB_PASSWORD || 'SecretPassword123',
  });
}

const pool = new Pool(poolOptions);

pool.on('error', (err) => {
  console.error('[DB Error] Unexpected error on idle client', err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
};
