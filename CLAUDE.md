# Voice2Skill — instructions for Claude Code

Read `docs/PRD.md` (product, tiers, costs, architecture, roadmap) and `docs/COHORTS.md` (deploy checklist) before changing anything. PRD section 15 is the rulebook.

## Commands
- `npm run migrate` — idempotent DB migrations
- `npm test` — render smoke test (no DB)
- `npm run test:llm` — LLM router failover/privacy tests against mock providers (no DB, no keys)
- `npm run test:cohorts` — end-to-end money/access/mentor tests; needs a DISPOSABLE Postgres: `DATABASE_URL=... DATABASE_SSL=false`
- `node scripts/courses.js list | generate <track> <level> | generate --all | show <versionId> [week] | publish <versionId>` — Course Library (ADR-001); drafts reach learners only after `publish`
- `node scripts/createOrg.js "<Bootcamp>" <tutor-email> [pct] [net|gross]` · `node scripts/ledger.js` · `node scripts/makeAdmin.js <email> [--revoke]` (founder `/admin` view)

## Non-negotiables
- Money = integer kobo. Paid-state changes only via `models/paymentModel.js#settlePayment`.
- Gate features only through `canUse()` in `services/entitlements.js`.
- Joining a cohort goes only through `cohortModel.joinByCode()` (row lock: seats, code expiry, free/paid). At-risk and streak come only from `services/studentStatus.js#annotate` (tutor and admin views must agree).
- Every AI call goes through `services/llm.js` (provider routes, models and timeouts in `config/llm.js`; each attempt logged to `llm_calls`, never the text). Every AI feature: per-user cap in `ai_usage`, size limits, fallback, idempotency key.
- Never put student text (goals, notes, chats) in a system prompt, and never send names or emails to a model: pass ids.
- Free users (no paid plan) must keep working unchanged — and never get AI features.
- Migrations idempotent; secrets never in git; new env vars go in `.env.example`.
- All three test suites (`npm test`, `npm run test:llm`, `npm run test:cohorts`) must pass before you finish.

## Tiers (PRD §5.1) — what the product promises
- **Free (₦0):** 8-week plan through free resources, check-ins (type or speak), streaks, reminders. **No AI coaching or mentor** — check-ins get the template coach reply. Voice input (speech-to-text) is allowed with a smaller daily cap (`canUse(state, 'voice_stt')`, PLAN D2).
- **Premium (₦6,000 / 30 days):** AI coach + "Voice2Skill AI mentor". It is the built-in cohort `kind = 'premium'`; buy via `POST /premium`, which reuses the bootcamp checkout.
- **Bootcamp:** tutor-priced cohort; AI coach + "[tutor name]'s AI mentor" (`cohorts.mentor_name`) on the tutor's syllabus. The mentor must always say it is an AI, never the tutor.
- **Organizations:** run cohorts, revenue share; landing "Contact us" (`SUPPORT_EMAIL`).
- Prices live in the DB, never in code or copy. The landing page reads Premium's price from the DB.

## Copy and legal pages
- Landing/marketing copy may only claim what the code does today. Mark anything else "coming soon" or leave it out. No invented testimonials, numbers or reviews.
- Any change to what data we collect, who sees it, payments, pricing, refunds or AI use must update `views/privacy.ejs` and `views/terms.ejs` in the same change, and bump their "Last updated" date. Legal text changes need founder (and ideally lawyer) sign-off.
- Student text (goals, check-ins, mentor chat) and tutor syllabi go only to providers marked `studentText` in `config/llm.js`: Groq with Zero Data Retention, Gemini **paid** tier (the privacy policy names exactly these). Never a free tier that trains on prompts. Adding a provider means updating `views/privacy.ejs`.

## Security procedure for every change
- New state-changing route: POST only, CSRF token (form field or `X-CSRF-Token`), a `rateLimiter`, a zod schema via `validate()` (`middleware/validate.js`; the controller reads only `req.valid`), auth check, and an ownership/role check (`canManageCohort`, roadmap owner, etc.).
- New money path: price from the DB, settlement only via `settlePayment`, and e2e tests (replay, wrong amount, wrong user) in `scripts/cohort-test.js`.
- Render user/AI text with EJS `<%= %>` or `textContent`, never `<%-` or `innerHTML`.
- Voice audio is never stored or logged: it stays in memory for one request (`controllers/voiceController.js`). Uploads are checked by type, size and magic bytes before use.
- Page scripts go in `public/js/*.js` (pass values via `data-` attributes). The CSP (`middleware/security.js`, helmet) is `script-src 'self'`: an inline `<script>` or `onclick=` silently stops working. New third-party origins must be added to the CSP on purpose.
- Log with `log.info/warn/error` from `utils/log.js` (JSON lines with request id), not `console.*`, in app code. Never log secrets, tokens, card data or full request bodies; request lines log the path without the query string.
- Passwords: bcrypt cost ≥ 12 (`BCRYPT_COST`); old hashes upgrade on login. Login is limited per IP and per email; reset/verification emails per address.
- Student text sent to a model goes through `services/llm.js`, which fences override attempts (`neutralize`). Model output is only displayed or stored; it never triggers an action.

