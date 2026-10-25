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
  // The security page and "log out other devices" look sessions up by the logged-in user id, which
  // lives inside the JSON. Without this index every such query parses every session row (the table
  // is full of anonymous rows too). Partial: anonymous sessions are not indexed at all. The
  // expression must match the one in models/userModel.js exactly for the planner to use it.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_session_user ON "session" ((sess::jsonb ->> 'userId'))
                    WHERE sess::jsonb ->> 'userId' IS NOT NULL`);
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP');
  console.log('✓ session table, session user index + users.password_changed_at ensured.');
  await pool.end();
}

migrateSessions().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
