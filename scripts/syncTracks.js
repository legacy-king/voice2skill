#!/usr/bin/env node
/**
 * Syncs the tracks table to match the landing page's skill track list.
 *
 * The landing page advertises: Web Development, UI/UX Design, Data Analysis,
 * Digital Marketing, Cybersecurity. Older databases may have a legacy
 * "Software Development" row instead of "Web Development", or be missing rows.
 * This script renames/updates/inserts rows idempotently — safe to run any time.
 *
 * Usage: node scripts/syncTracks.js
 */
const pool = require('../config/db');

const TARGET_TRACKS = [
  { name: 'Web Development',    description: 'HTML, CSS, JavaScript — build and ship real sites.' },
  { name: 'UI/UX Design',       description: 'Design thinking, Figma, and interfaces people love.' },
  { name: 'Data Analysis',      description: 'Spreadsheets, SQL, and insights that drive decisions.' },
  { name: 'Digital Marketing',  description: 'Content, SEO, and campaigns that reach people.' },
  { name: 'Cybersecurity',      description: 'Fundamentals of protecting systems and data.' }
];

async function syncTracks() {
  const { rows } = await pool.query('SELECT id, name FROM tracks');
  const existing = new Map(rows.map(r => [r.name.trim().toLowerCase(), r.id]));

  // Legacy rename: "Software Development" -> "Web Development" (only if Web Dev is absent)
  const legacyId = existing.get('software development');
  if (legacyId && !existing.has('web development')) {
    await pool.query('UPDATE tracks SET name = $1, description = $2 WHERE id = $3', [
      'Web Development',
      'HTML, CSS, JavaScript — build and ship real sites.',
      legacyId
    ]);
    existing.set('web development', legacyId);
    existing.delete('software development');
    console.log('↻ Renamed "Software Development" → "Web Development"');
  } else if (legacyId) {
    console.warn('⚠  Both "Software Development" and "Web Development" exist — legacy row left untouched. Review manually if it should be removed.');
  }

  for (const track of TARGET_TRACKS) {
    const key = track.name.toLowerCase();
    const id = existing.get(key);
    if (id) {
      await pool.query('UPDATE tracks SET description = $1 WHERE id = $2', [track.description, id]);
      console.log(`✓ Updated "${track.name}"`);
    } else {
      const ins = await pool.query(
        'INSERT INTO tracks (name, description) VALUES ($1, $2) RETURNING id',
        [track.name, track.description]
      );
      existing.set(key, ins.rows[0].id);
      console.log(`+ Inserted "${track.name}"`);
    }
  }

  console.log('\nTrack sync complete. All 5 landing-page tracks are present.');
  await pool.end();
}

syncTracks().catch(err => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
