const pool = require('../config/db');

/** Recent conversation, oldest first. */
async function getHistory(userId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, role, content, created_at FROM (
       SELECT id, role, content, created_at FROM mentor_messages
        WHERE user_id = $1 ORDER BY id DESC LIMIT $2
     ) t ORDER BY id ASC`,
    [userId, limit]
  );
  return rows;
}

/** The assistant reply for a previously-seen client message id, if one exists. */
async function findByClientMsgId(userId, clientMsgId) {
  const { rows } = await pool.query(
    `SELECT u.id AS user_msg_id, u.created_at,
            (SELECT a.content FROM mentor_messages a WHERE a.reply_to = u.id ORDER BY a.id LIMIT 1) AS reply
       FROM mentor_messages u WHERE u.user_id = $1 AND u.client_msg_id = $2`,
    [userId, clientMsgId]
  );
  return rows[0];
}

/** Insert the user's message. Returns null if this client_msg_id was already stored (race / retry). */
async function insertUserMessage({ userId, cohortId, content, clientMsgId }) {
  const { rows } = await pool.query(
    `INSERT INTO mentor_messages (user_id, cohort_id, role, content, client_msg_id)
     VALUES ($1, $2, 'user', $3, $4)
     ON CONFLICT (user_id, client_msg_id) WHERE client_msg_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [userId, cohortId, content, clientMsgId]
  );
  return rows[0] ? rows[0].id : null;
}

async function insertAssistantMessage({ userId, cohortId, content, replyTo }) {
  await pool.query(
    `INSERT INTO mentor_messages (user_id, cohort_id, role, content, reply_to)
     VALUES ($1, $2, 'assistant', $3, $4)`,
    [userId, cohortId, content, replyTo]
  );
}

async function deleteMessage(id) {
  await pool.query('DELETE FROM mentor_messages WHERE id = $1', [id]);
}

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

module.exports = {
  getHistory, findByClientMsgId, insertUserMessage, insertAssistantMessage,
  deleteMessage, bumpUsage, refundUsage, getUsage
};
