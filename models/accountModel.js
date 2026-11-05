/**
 * Account deletion (NDPA 2023 right to erasure) and the reminder opt-out.
 *
 * Deleting removes the person: their account, goals, check-ins (and coach replies), roadmaps,
 * assessments, mentor chats, usage counters, memberships, email log and every session. Payment
 * rows stay, unlinked (user_id NULL), because the revenue-share ledger and accounting depend on
 * them; they hold no name or email. llm_calls already unlinks itself (ON DELETE SET NULL).
 */
const pool = require('../config/db');

/**
 * @returns {Promise<'deleted'|'owns_org'|'not_found'>}
 *   owns_org: a tutor who owns a bootcamp; their cohorts and students can't be orphaned, so the
 *   founder handles it by hand (support email).
 */
async function deleteAccount(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!user.rowCount) {
      await client.query('ROLLBACK');
      return 'not_found';
    }
    const owns = await client.query('SELECT 1 FROM organizations WHERE owner_user_id = $1 LIMIT 1', [userId]);
    if (owns.rowCount) {
      await client.query('ROLLBACK');
      return 'owns_org';
    }
    // Children before parents: checkins -> roadmaps -> assessments (roadmaps.assessment_id).
    await client.query('DELETE FROM checkins WHERE user_id = $1', [userId]); // coach_responses cascade
    await client.query('DELETE FROM roadmaps WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM assessments WHERE user_id = $1', [userId]);
    await client.query('UPDATE payments SET user_id = NULL WHERE user_id = $1', [userId]);
    // Same expression as idx_session_user, so this uses the index.
    await client.query(`DELETE FROM "session" WHERE sess::jsonb ->> 'userId' = $1`, [String(userId)]);
    // memberships, ai_usage, mentor_messages, email_log cascade; llm_calls is set to NULL.
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    await client.query('COMMIT');
    return 'deleted';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function setRemindersOptOut(userId, optOut) {
  const { rowCount } = await pool.query('UPDATE users SET reminders_opt_out = $2 WHERE id = $1', [userId, !!optOut]);
  return rowCount > 0;
}

module.exports = { deleteAccount, setRemindersOptOut };
