# Voice2Skill — instructions for Claude Code

Read `docs/PRD.md` (product, tiers, costs, architecture, roadmap) and `docs/COHORTS.md` (deploy checklist) before changing anything. PRD section 15 is the rulebook.

## Commands
- `npm run migrate` — idempotent DB migrations
- `npm test` — render smoke test (no DB)
- `npm run test:cohorts` — end-to-end money/access/mentor tests; needs a DISPOSABLE Postgres: `DATABASE_URL=... DATABASE_SSL=false`
- `node scripts/createOrg.js "<Bootcamp>" <tutor-email> [pct] [net|gross]` · `node scripts/ledger.js`

## Non-negotiables
- Money = integer kobo. Paid-state changes only via `models/paymentModel.js#settlePayment`.
- Gate features only through `canUse()` in `utils/entitlements.js`.
- Every AI feature: per-user cap in `ai_usage`, size limits, timeout, fallback, idempotency key.
- Free users (no cohort) must keep working unchanged.
- Migrations idempotent; secrets never in git; new env vars go in `.env.example`.
- Both test suites must pass before you finish.
