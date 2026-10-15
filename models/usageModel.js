/**
 * Per-user, per-day AI usage counters (ai_usage). Every AI feature reserves budget here first
 * (atomic bump), and refunds it if the call fails, so caps can't be exceeded by concurrency.
 * Kinds: 'mentor', 'stt'.
 */
const pool = require('../config/db');

/** Atomically count one AI call today; returns the new count. */
async function bumpUsage(userId, kind) {
  const { rows } = await pool.query(
    `INSERT INTO ai_usage (user_id, day, kind, count) VALUES ($1, CURRENT_DATE, $2, 1)
     ON CONFLICT (user_id, day, kind) DO UPDATE SET count = ai_usage.count + 1
     RETURNING count`,
    [userId, kind]
  );
  return rows[0].count;
}

async function refundUsage(userId, kind) {
  await pool.query(
    `UPDATE ai_usage SET count = GREATEST(count - 1, 0)
      WHERE user_id = $1 AND day = CURRENT_DATE AND kind = $2`,
    [userId, kind]
  );
}

async function getUsage(userId, kind) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(count) FILTER (WHERE day = CURRENT_DATE), 0)::int AS today,
       COALESCE(SUM(count) FILTER (WHERE day >= date_trunc('month', CURRENT_DATE)), 0)::int AS month
     FROM ai_usage WHERE user_id = $1 AND kind = $2`,
    [userId, kind]
  );
  return rows[0];
}

module.exports = { bumpUsage, refundUsage, getUsage };
