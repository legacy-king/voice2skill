const { Pool } = require('pg');
require('dotenv').config();

const num = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // DATABASE_SSL=false is for a local Postgres only; hosted DBs (Neon) need SSL.
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: num('PG_POOL_MAX', 10),
  // Without these a stalled database (Neon waking from sleep, a dropped connection) leaves every
  // request waiting forever for a pool slot, and the backlog is what takes the instance down.
  connectionTimeoutMillis: num('PG_CONNECT_TIMEOUT_MS', 10000), // waiting for a free/new connection
  idleTimeoutMillis: num('PG_IDLE_TIMEOUT_MS', 30000),          // drop idle connections before Neon does
  statement_timeout: num('PG_STATEMENT_TIMEOUT_MS', 30000),     // server-side cap on one query
  query_timeout: num('PG_QUERY_TIMEOUT_MS', 35000),             // client-side backstop
  keepAlive: true,
  application_name: 'voice2skill-web'
});

// An error on an IDLE pooled connection (Neon closes idle connections and suspends compute) is
// emitted on the pool. With no listener Node treats it as an uncaught exception and the whole
// process dies; with one, the dead client is discarded and the next query gets a fresh one.
// Required reading: https://node-postgres.com/apis/pool#error
pool.on('error', (err) => {
  // Lazy require: utils/log has no dependencies, but this file loads first.
  require('../utils/log').log.warn('Idle database connection error (discarded, will reconnect)', { error: err.message });
});

module.exports = pool;
