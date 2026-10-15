const pool = require('../config/db');

/**
 * Create a new assessment record.
 */
async function createAssessment(userId, trackId, level, score, topicScores, answers) {
  const result = await pool.query(
    `INSERT INTO assessments (user_id, track_id, level, score, topic_scores, answers)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [userId, trackId, level, score, JSON.stringify(topicScores), JSON.stringify(answers)]
  );
  return result.rows[0];
}

/**
 * Get the latest assessment for a user on a specific track.
 */
async function getLatestAssessment(userId, trackId) {
  const result = await pool.query(
    `SELECT * FROM assessments
     WHERE user_id = $1 AND track_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [userId, trackId]
  );
  return result.rows[0];
}

async function getAssessmentById(id) {
  const result = await pool.query(
    'SELECT * FROM assessments WHERE id = $1',
    [id]
  );
  return result.rows[0];
}

module.exports = { createAssessment, getLatestAssessment, getAssessmentById };
