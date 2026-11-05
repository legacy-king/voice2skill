-- Account deletion and reminder opt-out (NDPA 2023: deletion on request, unsubscribe from email).
-- Idempotent: safe to run on every deploy.

-- A deleted user's payments stay for the revenue-share ledger and accounting, unlinked from them.
ALTER TABLE payments ALTER COLUMN user_id DROP NOT NULL;

-- Daily reminder emails are optional: the unsubscribe link and the Security page set this.
ALTER TABLE users ADD COLUMN IF NOT EXISTS reminders_opt_out BOOLEAN NOT NULL DEFAULT FALSE;
