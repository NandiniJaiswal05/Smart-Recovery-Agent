/**
 * Redis/Valkey configuration.
 * Render Key Value exposes a REDIS_URL; local Docker can use host/port.
 */
const REDIS_URL = process.env.REDIS_URL;

let REDIS_CONFIG;

if (REDIS_URL) {
  const parsed = new URL(REDIS_URL);
  REDIS_CONFIG = {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
  };
} else {
  REDIS_CONFIG = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

module.exports = { REDIS_CONFIG };
