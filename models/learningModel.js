/** Quiz self-check answers (db/learning.sql). Callers check roadmap ownership first. */
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

module.exports = { saveQuizAnswer, getQuizAnswers, getQuizScore };
