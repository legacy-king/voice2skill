-- Indexes for queries that were scanning whole tables (PRD finding #5, CPU audit 21 Oct 2026).
-- Idempotent: safe to run repeatedly (scripts/migratePerf.js). Tables are tiny today; these keep
-- the queries flat as users, roadmaps and payments grow.

-- getLatestAssessment(userId, trackId): WHERE user_id = $1 AND track_id = $2 ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_assessments_user_track ON assessments (user_id, track_id, created_at DESC);

-- findCachedRoadmap(): exact-goal reuse. The expression matches the query's LOWER(TRIM(r.goal)).
CREATE INDEX IF NOT EXISTS idx_roadmaps_goal_cache ON roadmaps (track_id, (LOWER(TRIM(goal))))
  WHERE is_cached = FALSE AND goal IS NOT NULL;

-- Per-student payment history, and org dashboards counting a cohort's rows.
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cohorts_org ON cohorts (org_id);
CREATE INDEX IF NOT EXISTS idx_org_payouts_org ON org_payouts (org_id);

-- One roadmap per learner per track (a double tap on "start this track" used to make several).
-- Not created while duplicates exist: those must be merged by hand first (migratePerf.js warns).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM roadmaps GROUP BY user_id, track_id HAVING COUNT(*) > 1) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_roadmaps_user_track ON roadmaps (user_id, track_id);
  END IF;
END $$;
