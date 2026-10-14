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
- Free users (no paid plan) must keep working unchanged — and never get AI features.
- Migrations idempotent; secrets never in git; new env vars go in `.env.example`.
- Both test suites must pass before you finish.

## Tiers (PRD §5.1) — what the product promises
- **Free (₦0):** 8-week plan through free resources, check-ins (type or speak), streaks, reminders. **No AI** — check-ins get the template coach reply.
- **Premium (₦6,000 / 30 days):** AI coach + "Voice2Skill AI mentor". It is the built-in cohort `kind = 'premium'`; buy via `POST /premium`, which reuses the bootcamp checkout.
- **Bootcamp:** tutor-priced cohort; AI coach + "[tutor name]'s AI mentor" (`cohorts.mentor_name`) on the tutor's syllabus. The mentor must always say it is an AI, never the tutor.
- **Organizations:** run cohorts, revenue share; landing "Contact us" (`SUPPORT_EMAIL`).
- Prices live in the DB, never in code or copy. The landing page reads Premium's price from the DB.

## Copy and legal pages
- Landing/marketing copy may only claim what the code does today. Mark anything else "coming soon" or leave it out. No invented testimonials, numbers or reviews.
- Any change to what data we collect, who sees it, payments, pricing, refunds or AI use must update `views/privacy.ejs` and `views/terms.ejs` in the same change, and bump their "Last updated" date. Legal text changes need founder (and ideally lawyer) sign-off.
- Student text (check-ins, mentor chat) and tutor syllabi go only to the **paid** Gemini tier (the privacy policy promises this).

## Security procedure for every change
- New state-changing route: POST only, CSRF token (form field or `X-CSRF-Token`), a `rateLimiter`, auth check, and an ownership/role check (`canManageCohort`, roadmap owner, etc.).
- New money path: price from the DB, settlement only via `settlePayment`, and e2e tests (replay, wrong amount, wrong user) in `scripts/cohort-test.js`.
- Render user/AI text with EJS `<%= %>` or `textContent`, never `<%-` or `innerHTML`.
- Never log secrets, tokens, card data or full request bodies.

