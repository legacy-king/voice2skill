#!/usr/bin/env node
/**
 * Applies db/perf.sql (extra indexes for hot queries).
 * Idempotent — safe to run multiple times.
 *
 * Usage: node scripts/migratePerf.js
 */
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'perf.sql'), 'utf8');
  await pool.query(sql);
  console.log('✓ performance indexes ensured.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
