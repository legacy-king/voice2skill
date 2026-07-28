const pool = require('../config/db');

async function createRoadmap(userId, trackId, content) {
  const result = await pool.query(
    'INSERT INTO roadmaps (user_id, track_id, content) VALUES ($1, $2, $3) RETURNING *',
    [userId, trackId, content]
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

module.exports = { createRoadmap, getRoadmapByUserAndTrack, getRoadmapById };