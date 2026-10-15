-- One row per email of a given kind per user per day. The UNIQUE key makes daily reminders
-- idempotent: a cron retry, a second trigger or a re-run job can never email someone twice.
-- Idempotent (scripts/migrateEmail.js).
CREATE TABLE IF NOT EXISTS email_log (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(30) NOT NULL,
  day DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, kind, day)
);
CREATE INDEX IF NOT EXISTS idx_email_log_day ON email_log (day, kind);
-- Reminder selection looks up today's / recent check-ins by date.
CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins (checkin_date);
CREATE INDEX IF NOT EXISTS idx_checkins_roadmap ON checkins (roadmap_id);
