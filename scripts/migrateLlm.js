#!/usr/bin/env node
/**
 * Applies db/llm.sql (llm_calls: one row per LLM provider attempt, no prompt text).
 * Idempotent — safe to run multiple times.
 *
 * Usage: node scripts/migrateLlm.js
 */
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'llm.sql'), 'utf8');
  await pool.query(sql);
  console.log('✓ llm_calls table ensured.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
