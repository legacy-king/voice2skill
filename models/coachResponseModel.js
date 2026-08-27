const pool = require('../config/db');

/**
 * Create a coach response for a check-in.
 */
async function createCoachResponse(checkinId, acknowledgement, insight, nextAction, isFallback = false) {
  const result = await pool.query(
    `INSERT INTO coach_responses (checkin_id, acknowledgement, insight, next_action, is_fallback)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [checkinId, acknowledgement, insight, nextAction, isFallback]
  );
  return result.rows[0];
}

/**
 * Get coach responses for a list of check-in IDs.
 */
async function getByCheckinIds(checkinIds) {
  if (!checkinIds || checkinIds.length === 0) return [];
  const result = await pool.query(
    `SELECT * FROM coach_responses WHERE checkin_id = ANY($1) ORDER BY created_at DESC`,
    [checkinIds]
  );
  return result.rows;
}

/**
 * Get the coach response for a specific check-in.
 */
async function getByCheckinId(checkinId) {
  const result = await pool.query(
    `SELECT * FROM coach_responses WHERE checkin_id = $1`,
    [checkinId]
  );
  return result.rows[0];
}

module.exports = { createCoachResponse, getByCheckinIds, getByCheckinId };
