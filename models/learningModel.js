/** Quiz self-check answers and weekly projects (db/learning.sql). Callers check roadmap ownership first. */
const pool = require('../config/db');

async function saveQuizAnswer(roadmapId, dayNumber, questionIndex, answer, correct) {
  await pool.query(
    `INSERT INTO quiz_answers (roadmap_id, day_number, question_index, answer, correct)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (roadmap_id, day_number, question_index)
     DO UPDATE SET answer = EXCLUDED.answer, correct = EXCLUDED.correct, updated_at = NOW()`,
    [roadmapId, dayNumber, questionIndex, answer, correct]
  );
}

/** One day's answers as { [questionIndex]: { answer, correct } }. */
async function getQuizAnswers(roadmapId, dayNumber) {
  const { rows } = await pool.query(
    'SELECT question_index, answer, correct FROM quiz_answers WHERE roadmap_id = $1 AND day_number = $2',
    [roadmapId, dayNumber]
  );
  return Object.fromEntries(rows.map((r) => [r.question_index, r]));
}

/** { correct, total } over the whole plan. */
async function getQuizScore(roadmapId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*) FILTER (WHERE correct)::int AS correct, COUNT(*)::int AS total FROM quiz_answers WHERE roadmap_id = $1',
    [roadmapId]
  );
  return rows[0];
}

/** Save a week's project. A changed submission clears old feedback; an identical one changes nothing. */
async function submitProject(roadmapId, weekNumber, url, note) {
  await pool.query(
    `INSERT INTO project_submissions (roadmap_id, week_number, url, note) VALUES ($1, $2, $3, $4)
     ON CONFLICT (roadmap_id, week_number) DO UPDATE
       SET url = EXCLUDED.url, note = EXCLUDED.note, submitted_at = NOW(), feedback = NULL, feedback_requested_at = NULL
       WHERE (project_submissions.url, project_submissions.note) IS DISTINCT FROM (EXCLUDED.url, EXCLUDED.note)`,
    [roadmapId, weekNumber, url, note]
  );
}

/**
 * Claim the AI feedback call for a submission without feedback. Only one concurrent request gets
 * the row (the idempotency key is the submission itself); a claim older than 2 minutes is stale.
 */
async function claimFeedback(roadmapId, weekNumber) {
  const { rows } = await pool.query(
    `UPDATE project_submissions SET feedback_requested_at = NOW()
      WHERE roadmap_id = $1 AND week_number = $2 AND feedback IS NULL
        AND (feedback_requested_at IS NULL OR feedback_requested_at < NOW() - INTERVAL '2 minutes')
      RETURNING url, note, submitted_at::text AS version`,
    [roadmapId, weekNumber]
  );
  return rows[0] || null;
}

/** Store feedback, unless the learner re-submitted something else meanwhile. */
async function saveFeedback(roadmapId, weekNumber, version, feedback) {
  await pool.query(
    'UPDATE project_submissions SET feedback = $4 WHERE roadmap_id = $1 AND week_number = $2 AND submitted_at = $3::timestamptz',
    [roadmapId, weekNumber, version, feedback]
  );
}

/** Give the claim back (AI failed or over the cap), so a later submit can try again. */
async function releaseFeedback(roadmapId, weekNumber) {
  await pool.query('UPDATE project_submissions SET feedback_requested_at = NULL WHERE roadmap_id = $1 AND week_number = $2', [roadmapId, weekNumber]);
}

async function getProject(roadmapId, weekNumber) {
  const { rows } = await pool.query(
    'SELECT url, note, feedback FROM project_submissions WHERE roadmap_id = $1 AND week_number = $2',
    [roadmapId, weekNumber]
  );
  return rows[0] || null;
}

module.exports = {
  saveQuizAnswer, getQuizAnswers, getQuizScore,
  submitProject, claimFeedback, saveFeedback, releaseFeedback, getProject
};
