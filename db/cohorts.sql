-- Cohorts / bootcamp partnerships / payments / mentor chat.
-- Idempotent: safe to run repeatedly (scripts/migrateCohorts.js).
-- Money is ALWAYS stored as integer kobo (1 NGN = 100 kobo). Never floats.

ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'student';

-- A bootcamp / tutor. Created by an admin script, not by open signup.
CREATE TABLE IF NOT EXISTS organizations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  -- Bootcamp's cut. 'net' = % of amount after the payment-provider fee, 'gross' = % of amount paid.
  revenue_share_pct NUMERIC(5,2) NOT NULL DEFAULT 20
    CHECK (revenue_share_pct >= 0 AND revenue_share_pct <= 100),
  share_basis VARCHAR(10) NOT NULL DEFAULT 'net' CHECK (share_basis IN ('gross', 'net')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One teaching group. The invite code is what students type to join.
CREATE TABLE IF NOT EXISTS cohorts (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  name VARCHAR(150) NOT NULL,
  invite_code VARCHAR(12) UNIQUE NOT NULL,
  price_kobo INTEGER NOT NULL DEFAULT 0 CHECK (price_kobo >= 0),
  access_days INTEGER NOT NULL DEFAULT 30 CHECK (access_days > 0),
  -- The tutor's syllabus. The AI mentor is grounded in this text.
  curriculum TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memberships (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cohort_id INTEGER NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
  role VARCHAR(10) NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'teacher')),
  status VARCHAR(20) NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment', 'active', 'cancelled')),
  access_until TIMESTAMPTZ,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, cohort_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_cohort ON memberships (cohort_id);

-- One row per checkout attempt. `reference` is unique => a replayed webhook cannot double-credit.
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  cohort_id INTEGER NOT NULL REFERENCES cohorts(id),
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  reference VARCHAR(100) UNIQUE NOT NULL,
  amount_kobo INTEGER NOT NULL CHECK (amount_kobo > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  provider_fee_kobo INTEGER NOT NULL DEFAULT 0,
  org_share_kobo INTEGER NOT NULL DEFAULT 0,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payments_org ON payments (org_id, status);

-- Money actually sent to a bootcamp (bank transfer). Owed = sum(org_share) - sum(payouts).
CREATE TABLE IF NOT EXISTS org_payouts (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  amount_kobo INTEGER NOT NULL CHECK (amount_kobo > 0),
  note TEXT,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-user, per-day AI call counter. Enforces the cost cap atomically.
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  kind VARCHAR(30) NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, kind)
);

CREATE TABLE IF NOT EXISTS mentor_messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cohort_id INTEGER NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
  role VARCHAR(10) NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  -- Browser-generated id for a user message. Unique per user => double-submit / retry is a no-op.
  client_msg_id VARCHAR(64),
  -- For assistant rows: the user message this answers.
  reply_to INTEGER REFERENCES mentor_messages(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mentor_msg_idem
  ON mentor_messages (user_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mentor_msg_user ON mentor_messages (user_id, id DESC);

-- ---------------------------------------------------------------------------------------------
-- Tiers. Free = no AI. Premium (individual) and Bootcamp cohorts = paid, with the AI coach and
-- mentor. Premium is a built-in cohort of kind 'premium' owned by the platform organization, so it
-- reuses the same checkout, webhook, settlePayment() and access_until expiry as bootcamp cohorts.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'bootcamp';
DO $$ BEGIN
  ALTER TABLE cohorts ADD CONSTRAINT cohorts_kind_check CHECK (kind IN ('bootcamp', 'premium'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_premium_cohort ON cohorts (kind) WHERE kind = 'premium';

-- Name the AI mentor goes by for this cohort ("Tunde's AI mentor"). NULL = the org owner's name.
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS mentor_name VARCHAR(80);

-- The platform organization (owner of the Premium cohort) has no owning tutor.
ALTER TABLE organizations ALTER COLUMN owner_user_id DROP NOT NULL;

-- Seed Premium once: ₦6,000 (600000 kobo) for 30 days, no revenue share. The price lives in the
-- DB, so changing it is `UPDATE cohorts SET price_kobo = ... WHERE kind = 'premium'`, not a deploy.
DO $$
DECLARE platform_org INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cohorts WHERE kind = 'premium') THEN
    INSERT INTO organizations (name, owner_user_id, revenue_share_pct, share_basis)
      VALUES ('Voice2Skill', NULL, 0, 'gross') RETURNING id INTO platform_org;
    INSERT INTO cohorts (org_id, name, invite_code, price_kobo, access_days, kind, mentor_name)
      VALUES (platform_org, 'Voice2Skill Premium', 'V2SPREMIUM', 600000, 30, 'premium', 'Voice2Skill');
  END IF;
END $$;
