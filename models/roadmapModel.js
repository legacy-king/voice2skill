const pool = require('../config/db');
const { getVersionContent } = require('./courseModel');

/**
 * Library-backed roadmaps (ADR-001) store content = NULL and point at a course version.
 * Every reader gets `roadmap.content` filled in, so callers never need to know the difference.
 */
async function withContent(row) {
  if (row && row.content == null && row.course_version_id) {
    row.content = await getVersionContent(row.course_version_id);
    if (!row.content) throw new Error(`roadmap ${row.id}: course version ${row.course_version_id} is not available`);
  }
  return row;
}

async function createRoadmap(userId, trackId, content, goal = null, assessmentId = null, isCached = false) {
  const result = await pool.query(
    'INSERT INTO roadmaps (user_id, track_id, goal, content, assessment_id, is_cached) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING *',
    [userId, trackId, goal, content, assessmentId, isCached]
  );
  // A concurrent request (double tap) created it first: use that one.
  return result.rows[0] || getRoadmapByUserAndTrack(userId, trackId);
}

/** A roadmap that references a published Course Library version instead of holding a copy. */
async function createLibraryRoadmap(userId, trackId, courseVersionId, goal = null, assessmentId = null) {
  const result = await pool.query(
    'INSERT INTO roadmaps (user_id, track_id, goal, content, assessment_id, course_version_id) VALUES ($1, $2, $3, NULL, $4, $5) ON CONFLICT DO NOTHING RETURNING *',
    [userId, trackId, goal, assessmentId, courseVersionId]
  );
  return result.rows[0] ? withContent(result.rows[0]) : getRoadmapByUserAndTrack(userId, trackId);
}

async function getRoadmapByUserAndTrack(userId, trackId) {
    const result = await pool.query(
        'SELECT * FROM roadmaps WHERE user_id = $1 AND track_id = $2 ORDER BY id LIMIT 1',
        [userId, trackId]
    );
    return withContent(result.rows[0]);
}

async function getRoadmapById(id) {
    const result = await pool.query(
        'SELECT * FROM roadmaps WHERE id = $1',
        [id]
    );
    return withContent(result.rows[0]);
}

async function getRoadmapByUser(userId) {
  const result = await pool.query(
    'SELECT * FROM roadmaps WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [userId]
  );
  return withContent(result.rows[0]);
}

async function findCachedRoadmap(trackId, normalizedGoal, level) {
  // Only per-user generated rows can be copied; library-backed rows hold no content of their own.
  const result = await pool.query(
    `SELECT r.* FROM roadmaps r
     LEFT JOIN assessments a ON r.assessment_id = a.id
     WHERE r.track_id = $1
       AND LOWER(TRIM(r.goal)) = $2
       AND COALESCE(a.level, 'none') = COALESCE($3, 'none')
       AND r.is_cached = FALSE
       AND r.content IS NOT NULL
       AND r.goal IS NOT NULL AND TRIM(r.goal) <> ''
     ORDER BY r.created_at ASC
     LIMIT 1`,
    [trackId, normalizedGoal, level]
  );
  return result.rows[0];
}

/**
 * Runs fn() while holding a Postgres advisory lock for this (user, track), so concurrent
 * submissions for the same learner and track (a double-click, two tabs, a retry while the first
 * request is still generating) build the roadmap at most once and make at most one AI call.
 *
 * Session-level lock on a dedicated pooled connection: it works across instances, is released in
 * finally, and Postgres drops it on its own if the connection dies. The connection stays checked
 * out for the whole build (minutes for per-user AI generation; instant for library roadmaps).
 * Resolves { acquired: false } at once, without waiting, if another request holds the lock.
 */
async function withGenerationLock(userId, trackId, fn) {
  const key = `roadmap-gen:${userId}:${trackId}`;
  const client = await pool.connect();
  let acquired = false;
  let unlockFailed = false;
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [key]);
    acquired = rows[0].ok === true;
    if (!acquired) return { acquired: false };
    return { acquired: true, value: await fn() };
  } finally {
    if (acquired) {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]).catch(() => { unlockFailed = true; });
    }
    // A connection that may still hold the lock is destroyed, not returned to the pool.
    client.release(unlockFailed ? true : undefined);
  }
}

module.exports = { createRoadmap, createLibraryRoadmap, getRoadmapByUserAndTrack, getRoadmapById, getRoadmapByUser, findCachedRoadmap, withGenerationLock };
