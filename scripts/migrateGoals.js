#!/usr/bin/env node
/**
 * Adds the `goal` column to an existing roadmaps table (created before the
 * goal-persistence feature). Safe to run multiple times (idempotent).
 *
 * Usage: node scripts/migrateGoals.js
 */
const pool = require('../config/db');

async function migrateGoals() {
  await pool.query('ALTER TABLE roadmaps ADD COLUMN IF NOT EXISTS goal TEXT');
  console.log('✓ roadmaps.goal column ensured.');
  await pool.end();
}

migrateGoals().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
