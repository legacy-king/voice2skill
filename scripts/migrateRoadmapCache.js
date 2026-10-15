#!/usr/bin/env node
/**
 * Adds roadmaps.is_cached (marks roadmaps copied from another user's identical goal).
 * Safe to run multiple times (idempotent).
 *
 * Usage: node scripts/migrateRoadmapCache.js
 */
const pool = require('../config/db');

async function migrate() {
  await pool.query('ALTER TABLE roadmaps ADD COLUMN IF NOT EXISTS is_cached BOOLEAN NOT NULL DEFAULT FALSE');
  console.log('✓ roadmaps.is_cached column ensured.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
