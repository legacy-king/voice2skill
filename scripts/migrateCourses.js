#!/usr/bin/env node
/**
 * Applies db/courses.sql (courses, course_versions, jobs, roadmaps.course_version_id + indexes).
 * Idempotent — safe to run multiple times. Needs db/cohorts.sql first (courses.cohort_id).
 *
 * Usage: node scripts/migrateCourses.js
 */
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'courses.sql'), 'utf8');
  await pool.query(sql);
  console.log('✓ course library / jobs tables ensured.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
