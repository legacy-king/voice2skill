#!/usr/bin/env node
/**
 * Runs all idempotent database migrations in dependency order.
 *
 * Each migration script boots its own pg pool and calls pool.end(), so we
 * spawn each as a separate process and wait for it to finish before the next.
 * A failure stops the chain with a non-zero exit code.
 *
 * NOT included: migrateRoadmaps.js — a one-off Gemini-dependent data migration
 * (regenerates roadmap content via the AI API), not safe to run casually.
 *
 * Usage: npm run migrate   (or: node scripts/migrate.js)
 */
const { spawn } = require('child_process');
const path = require('path');

const MIGRATIONS = [
  'migrateGoals.js',          // roadmaps.goal column
  'migrateVerification.js',   // users.email_verified + verification token columns
  'migratePasswordReset.js',  // users.password_reset_token columns
  'migrateSessions.js',       // session table + users.password_changed_at
  'syncTracks.js'             // syncs the 5 landing-page tracks
];

const TIMEOUT_MS = 120 * 1000; // guard against a hanging DB connection

function runMigration(file) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, file);
    const child = spawn(process.execPath, [scriptPath], { stdio: 'inherit' });

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${file} timed out after ${TIMEOUT_MS / 1000}s — killed.`));
    }, TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`${file} could not be started: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const why = code !== null ? `exit ${code}` : `signal ${signal}`;
        return reject(new Error(`${file} failed (${why})`));
      }
      resolve();
    });
  });
}

async function main() {
  console.log(`Running ${MIGRATIONS.length} migrations against the configured database…\n`);
  for (const file of MIGRATIONS) {
    process.stdout.write(`▶ ${file} … `);
    const start = Date.now();
    await runMigration(file);
    console.log(`✓ ${file} done in ${((Date.now() - start) / 1000).toFixed(1)}s\n`);
  }
  console.log('All migrations complete.');
}

main().catch((err) => {
  console.error(`\n✗ Migration aborted: ${err.message}`);
  process.exit(1);
});
