#!/usr/bin/env node
/**
 * Applies db/schema.sql (users, tracks, assessments, roadmaps, checkins, coach_responses,
 * session). Every statement is IF NOT EXISTS / seed-if-empty, so on an existing database this
 * is a no-op and on a fresh one it creates the base tables the other migrations alter.
 *
 * Usage: node scripts/migrateBase.js
 */
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('✓ base tables ensured.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
