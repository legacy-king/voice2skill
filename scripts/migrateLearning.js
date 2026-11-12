#!/usr/bin/env node
/**
 * Applies db/learning.sql (quiz answers, weekly project submissions).
 * Idempotent — safe to run multiple times.
 *
 * Usage: node scripts/migrateLearning.js
 */
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'learning.sql'), 'utf8');
  await pool.query(sql);
  console.log('✓ learning tables ensured.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
