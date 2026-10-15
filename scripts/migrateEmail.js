#!/usr/bin/env node
/**
 * Applies db/email.sql (email_log for idempotent daily reminders + check-in date indexes).
 * Idempotent — safe to run multiple times.
 *
 * Usage: node scripts/migrateEmail.js
 */
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'email.sql'), 'utf8');
  await pool.query(sql);
  console.log('✓ email_log table ensured.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
