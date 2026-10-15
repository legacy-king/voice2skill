-- LLM router call log (services/llm.js). One row per provider ATTEMPT, so a failover shows up as
-- a failed row followed by a successful one. Tells us when a free tier runs out.
-- Never stores prompt or reply text. Idempotent (scripts/migrateLlm.js).

CREATE TABLE IF NOT EXISTS llm_calls (
  id BIGSERIAL PRIMARY KEY,
  provider VARCHAR(20) NOT NULL,
  model VARCHAR(100) NOT NULL,
  task VARCHAR(30) NOT NULL,
  streamed BOOLEAN NOT NULL DEFAULT FALSE,
  latency_ms INTEGER NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  ok BOOLEAN NOT NULL,
  -- HTTP status ('429', '503'), or 'timeout', 'network', 'invalid_json', 'invalid_schema', 'empty'.
  error_code VARCHAR(30),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls (created_at);
CREATE INDEX IF NOT EXISTS idx_llm_calls_provider_created ON llm_calls (provider, created_at);
