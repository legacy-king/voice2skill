#!/usr/bin/env node
/**
 * Adds the connect-pg-simple `session` table and the `users.password_changed_at`
 * column to an existing database. Idempotent — safe to run multiple times.
 *
 * Usage: node scripts/migrateSessions.js
 */
const pool = require('../config/db');

async function migrateSessions() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire")');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP');
  console.log('✓ session table + users.password_changed_at ensured.');
  await pool.end();
}

migrateSessions().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
