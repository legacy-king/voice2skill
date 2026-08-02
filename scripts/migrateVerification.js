#!/usr/bin/env node
/**
 * Adds email-verification columns to an existing users table (created before
 * the verification feature). Idempotent — safe to run multiple times.
 *
 * Existing accounts are grandfathered in as verified so nobody gets locked out.
 *
 * Usage: node scripts/migrateVerification.js
 */
const pool = require('../config/db');

async function migrateVerification() {
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token TEXT');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token_expires TIMESTAMP');

  // Grandfather pre-existing accounts (they signed up before verification existed).
  await pool.query(
    'UPDATE users SET email_verified = TRUE WHERE email_verified IS FALSE AND verification_token IS NULL'
  );

  console.log('✓ users.email_verified / verification_token columns ensured; existing accounts verified.');
  await pool.end();
}

migrateVerification().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
