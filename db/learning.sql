-- Learning loop: quiz self-check answers and weekly projects. Idempotent (scripts/migrateLearning.js).
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

-- Weekly project: one submission per week (a re-submission replaces it). `feedback` is AI feedback
-- on paid plans; feedback_requested_at claims the AI call so a double tap pays once.
CREATE TABLE IF NOT EXISTS project_submissions (
  roadmap_id INTEGER NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
  week_number SMALLINT NOT NULL,
  url TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  feedback TEXT,
  feedback_requested_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (roadmap_id, week_number)
);
