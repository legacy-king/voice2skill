#!/usr/bin/env node
/**
 * Adds password-reset columns to an existing users table (created before the
 * feature). Idempotent — safe to run multiple times.
 *
 * Usage: node scripts/migratePasswordReset.js
 */
const pool = require('../config/db');

async function migratePasswordReset() {
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token TEXT');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_expires TIMESTAMP');
  console.log('✓ users.password_reset_token / password_reset_token_expires columns ensured.');
  await pool.end();
}

migratePasswordReset().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
