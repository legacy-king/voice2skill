-- Course Library (ADR-001): each track x level plan is generated ONCE, reviewed, published, and
-- referenced by roadmaps instead of being regenerated per user.
-- Idempotent: safe to run repeatedly (scripts/migrateCourses.js). Run AFTER db/cohorts.sql.

-- A course is a track x level plan (library) or, later, one cohort's plan (cohort_id set).
CREATE TABLE IF NOT EXISTS courses (
  id SERIAL PRIMARY KEY,
  track_id INTEGER NOT NULL REFERENCES tracks(id),
  level VARCHAR(20) NOT NULL CHECK (level IN ('foundation', 'builder', 'professional')),
  cohort_id INTEGER REFERENCES cohorts(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_courses_library ON courses (track_id, level) WHERE cohort_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_courses_cohort ON courses (cohort_id) WHERE cohort_id IS NOT NULL;

-- Generated plans land as 'draft'; a human publishes one. Published and retired versions are
-- immutable (roadmaps point at them and the app caches them in memory by id).
CREATE TABLE IF NOT EXISTS course_versions (
  id SERIAL PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  status VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  content JSONB NOT NULL,
  model VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  UNIQUE (course_id, version)
);
-- At most one published version per course.
CREATE UNIQUE INDEX IF NOT EXISTS uq_course_versions_published
  ON course_versions (course_id) WHERE status = 'published';

-- Enforce immutability in the DB, not just in code: once a version leaves 'draft' its content
-- never changes, and it can never go back to 'draft'.
CREATE OR REPLACE FUNCTION course_versions_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' AND NEW.content IS DISTINCT FROM OLD.content THEN
    RAISE EXCEPTION 'course_versions % is % and its content is immutable', OLD.id, OLD.status;
  END IF;
  IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'course_versions % cannot go back to draft', OLD.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_course_versions_guard ON course_versions;
CREATE TRIGGER trg_course_versions_guard BEFORE UPDATE ON course_versions
  FOR EACH ROW EXECUTE FUNCTION course_versions_guard();

-- Background work queue, polled by the in-process runner (utils/jobRunner.js) with
-- FOR UPDATE SKIP LOCKED. dedupe_key makes enqueueing idempotent while a job is pending.
CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  kind VARCHAR(40) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(10) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  result JSONB,
  dedupe_key VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jobs_ready ON jobs (run_after, id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_jobs_running ON jobs (locked_at) WHERE status = 'running';
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_pending_dedupe
  ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

-- Library-backed roadmaps store content = NULL and point at a published version. Existing rows
-- keep their own content and are never rewritten.
ALTER TABLE roadmaps ADD COLUMN IF NOT EXISTS course_version_id INTEGER REFERENCES course_versions(id);
ALTER TABLE roadmaps ALTER COLUMN content DROP NOT NULL;
DO $$ BEGIN
  ALTER TABLE roadmaps ADD CONSTRAINT roadmaps_content_source_check
    CHECK (content IS NOT NULL OR course_version_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- PRD finding #5: roadmaps are looked up by user on every page; versions by roadmap reference.
CREATE INDEX IF NOT EXISTS idx_roadmaps_user ON roadmaps (user_id);
CREATE INDEX IF NOT EXISTS idx_roadmaps_course_version ON roadmaps (course_version_id) WHERE course_version_id IS NOT NULL;
