#!/usr/bin/env node
/**
 * Applies db/account.sql (account deletion: nullable payments.user_id; users.reminders_opt_out).
 * Idempotent — safe to run multiple times.
 *
 * Usage: node scripts/migrateAccount.js
 */
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'account.sql'), 'utf8');
  await pool.query(sql);
  console.log('✓ account deletion and reminder opt-out columns ensured.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
