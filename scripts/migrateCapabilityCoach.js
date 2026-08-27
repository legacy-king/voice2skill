#!/usr/bin/env node
/**
 * Adds capability coach tables and columns.
 *
 * - assessments table: stores learner capability profiles
 * - coach_responses table: stores AI coaching after check-ins
 * - roadmaps.assessment_id: links roadmaps to their assessment
 *
 * Safe to run multiple times (idempotent).
 *
 * Usage: node scripts/migrateCapabilityCoach.js
 */
const pool = require('../config/db');

async function migrateCapabilityCoach() {
  // Assessments table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS assessments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      track_id INTEGER NOT NULL REFERENCES tracks(id),
      level VARCHAR(20) NOT NULL,
      score INTEGER NOT NULL,
      topic_scores JSONB NOT NULL,
      answers JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✓ assessments table ensured.');

  // Add assessment_id to roadmaps
  await pool.query('ALTER TABLE roadmaps ADD COLUMN IF NOT EXISTS assessment_id INTEGER REFERENCES assessments(id)');
  console.log('✓ roadmaps.assessment_id column ensured.');

  // Coach responses table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coach_responses (
      id SERIAL PRIMARY KEY,
      checkin_id INTEGER UNIQUE NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
      acknowledgement TEXT NOT NULL,
      insight TEXT NOT NULL,
      next_action TEXT NOT NULL,
      is_fallback BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✓ coach_responses table ensured.');

  await pool.end();
}

migrateCapabilityCoach().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
