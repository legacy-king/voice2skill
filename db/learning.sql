-- Learning loop: quiz self-check answers. Idempotent (scripts/migrateLearning.js).
-- Rows go with their roadmap (ON DELETE CASCADE), so account deletion removes them too.

-- One answer per question; answering again replaces it. `correct` is the learner's own mark.
CREATE TABLE IF NOT EXISTS quiz_answers (
  roadmap_id INTEGER NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
  day_number SMALLINT NOT NULL,
  question_index SMALLINT NOT NULL,
  answer TEXT NOT NULL,
  correct BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (roadmap_id, day_number, question_index)
);
