#!/usr/bin/env node
/**
 * Applies db/cohorts.sql (orgs, cohorts, memberships, payments, usage, mentor chat).
 * Idempotent — safe to run multiple times. Run AFTER `npm run migrate`.
 *
 * Usage: node scripts/migrateCohorts.js
 */
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'cohorts.sql'), 'utf8');
  await pool.query(sql);
  console.log('✓ cohort / payment / mentor tables ensured.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
