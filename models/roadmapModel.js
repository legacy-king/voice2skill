const pool = require('../config/db');

async function createRoadmap(userId, trackId, content, goal = null, assessmentId = null, isCached = false) {
  const result = await pool.query(
    'INSERT INTO roadmaps (user_id, track_id, goal, content, assessment_id, is_cached) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [userId, trackId, goal, content, assessmentId, isCached]
  );
  return result.rows[0];
}

async function getRoadmapByUserAndTrack(userId, trackId) {
    const result = await pool.query(
        'SELECT * FROM roadmaps WHERE user_id = $1 AND track_id = $2',
        [userId, trackId]
    );
    return result.rows[0];
}

async function getRoadmapById(id) {
    const result = await pool.query(
        'SELECT * FROM roadmaps WHERE id = $1',
        [id]
    );
    return result.rows[0];
}

async function getRoadmapByUser(userId) {
  const result = await pool.query(
    'SELECT * FROM roadmaps WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [userId]
  );
  return result.rows[0];
}

async function findCachedRoadmap(trackId, normalizedGoal, level) {
  const result = await pool.query(
    `SELECT r.* FROM roadmaps r
     LEFT JOIN assessments a ON r.assessment_id = a.id
     WHERE r.track_id = $1
       AND LOWER(TRIM(r.goal)) = $2
       AND COALESCE(a.level, 'none') = COALESCE($3, 'none')
       AND r.is_cached = FALSE
       AND r.goal IS NOT NULL AND TRIM(r.goal) <> ''
     ORDER BY r.created_at ASC
     LIMIT 1`,
    [trackId, normalizedGoal, level]
  );
  return result.rows[0];
}

module.exports = { createRoadmap, getRoadmapByUserAndTrack, getRoadmapById, getRoadmapByUser, findCachedRoadmap };