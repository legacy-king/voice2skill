const pool = require('../config/db');

async function createRoadmap(userId, trackId, content, goal = null, assessmentId = null) {
  const result = await pool.query(
    'INSERT INTO roadmaps (user_id, track_id, goal, content, assessment_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [userId, trackId, goal, content, assessmentId]
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

module.exports = { createRoadmap, getRoadmapByUserAndTrack, getRoadmapById, getRoadmapByUser };