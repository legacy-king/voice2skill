# Voice2Skill — Codebase Audit

**Date:** 15 Oct 2026 · **Audited:** branch `feat/rebuild-plan` = `main` + cohorts/payments/Premium (`feat/cohorts-payments-mentor`) + Course Library (`feat/course-library`). None of these branches is pushed or merged yet.
**Brief:** `voice2skill-claude-code-prompt.md` (build brief, Phases 1–7).

> **Read this first.** The brief was written before a lot of what it asks for was built. Phase 4 (cohort codes, Paystack, revenue share, tutor view) and half of Phase 2 (shared roadmap skeletons, AI caps, jobs table) already exist on the branches above and pass 110 end-to-end checks. Three parts of the brief also contradict decisions already shipped: free-tier LLMs vs the published privacy policy, AI for Free users, and the Phase 4 table names. See `docs/PLAN.md` §0 for the decisions I need from you.

---

## 1. What exists and works

### Stack and layout
- Node 22, Express 5, EJS, `pg` (no ORM). Hosted on Render; Neon Postgres. One web process.
- `routes/` (thin) → `controllers/` (request handling + some business logic) → `models/` (parameterised SQL) → `utils/` (services: AI, mail, Paystack, entitlements, jobs) and `middleware/` (security, entitlements).
- Migrations: `npm run migrate` runs idempotent scripts in order (`scripts/migrate*.js`, `db/*.sql`). They are forward-only.
- Tests: `npm test` (EJS render smoke test plus unit checks, no DB) and `npm run test:cohorts` (110 HTTP end-to-end checks against a disposable Postgres, with mock Paystack and mock AI).

### Features
| Area | State | Where |
|---|---|---|
| Signup, email verification, login, logout, forgot/reset password, change password, device sessions page, new-device alert | Works | `controllers/userController.js`, `models/userModel.js` |
| Goal capture (typed, or spoken via Web Speech API) → track match | Works | `views/dashboard.ejs`, `utils/goalMatcher.js` |
| Capability assessment (Software Engineering only) → level | Works | `controllers/assessmentController.js`, `utils/capabilityAssessment.js` |
| 8-week roadmap: Course Library (published track×level plan, 0 AI calls) with per-user Gemini fallback plus exact-goal cache | Works; library plans not yet generated or published | `controllers/roadmapController.js`, `models/courseModel.js`, `utils/courseGenerator.js` |
| Daily check-in (typed or spoken), one per day, streak | Works | `controllers/checkinController.js`, `utils/streak.js` |
| Check-in coach reply: Gemini for paid users, template for Free | Works | `utils/coachService.js` |
| AI mentor chat (Premium and bootcamp): idempotent, daily and monthly caps, refund on failure, tutor-named persona | Works | `controllers/mentorController.js`, `utils/mentorService.js` |
| Organizations, cohorts, invite codes, memberships, teacher dashboard (roster, check-in counts, never note text), revenue share and ledger | Works | `controllers/cohortController.js`, `controllers/teacherController.js`, `db/cohorts.sql`, `scripts/ledger.js` |
| Paystack checkout, HMAC-signed webhook, idempotent `settlePayment()` (row lock, amount match), Premium ₦6,000/30 days from the DB | Works | `utils/paystack.js`, `models/paymentModel.js` |
| Entitlements: one `canUse(state, feature)` | Works | `utils/entitlements.js` |
| Daily reminder email (external cron → secret URL → Brevo) | Works, with problems (§2) | `controllers/reminderController.js`, `utils/mailer.js` |
| Background jobs table and in-process runner (`FOR UPDATE SKIP LOCKED`) | Works | `utils/jobRunner.js`, `db/courses.sql` |
| Landing, privacy and terms pages (tiers, Paystack, NDPA 2023) | Works | `views/` |

### Security already in place
- bcrypt password hashing. Verification and reset tokens are random, stored as **SHA-256 hashes**, expire, and are **single-use** (cleared on use).
- Session in Postgres (`connect-pg-simple`), `httpOnly`, `sameSite=lax`, `secure` in production, `regenerate()` on login (prevents session fixation). Password change revokes other sessions.
- CSRF token on every state-changing request (form field or `X-CSRF-Token` header).
- Hand-rolled rate limiter. It keys on the user when logged in (a class shares one IP) and on the IP otherwise. Auth, join-code, pay and mentor routes have tighter limits.
- Body limits: 10 kb for form/JSON, 100 kb raw for the webhook.
- Parameterised SQL throughout (no string-built queries found).
- AI output and user text rendered with `<%= %>`. An XSS test covers the mentor. AI `resource_url` values are restricted to http(s).
- The server refuses to start in production without `SESSION_SECRET`, or with any `*_MOCK` set.
- Central error handler returns a generic 500 with no stack trace.
- Mentor prompt treats student text as data; student text goes in user turns, not the system prompt.

## 2. What is broken, risky or insecure

Severity: **H** high, **M** medium, **L** low.

| # | Finding | Sev | Evidence |
|---|---|---|---|
| A1 | `npm audit`: **critical** `proxy-addr` (IP spoofing; we use `trust proxy`), **high** `nodemailer` (7 advisories), moderate `qs`. All have fixes. `nodemailer`, `node-cron` and `@anthropic-ai/sdk` are **not used anywhere** in the code. | **H** | `npm audit --omit=dev` |
| A2 | No Content-Security-Policy and no HSTS. Headers are hand-set (nosniff, frame DENY, referrer). Inline `<script>` blocks in `dashboard.ejs`, `roadmap.ejs` and `mentor.ejs` block a strict CSP until they get nonces or move to files. | **H** | `middleware/security.js` |
| A3 | No schema validation library. Inputs are checked by hand per controller: mostly fine, but inconsistent (e.g. `assessmentId` from the query string). | M | controllers |
| A4 | bcrypt cost is **10** (brief requires ≥ 12). | M | `userController.js:88,230,304` |
| A5 | Check-in coach Gemini call has **no timeout and no `maxOutputTokens`**, and puts goal and notes inside one prompt string, not a user turn. The model name is hard-coded in 3 places. | M | `utils/coachService.js:105` |
| A6 | AI calls are **not logged** anywhere: no provider, latency, tokens or errors. There is no way to see when a quota runs out. | M | — |
| A7 | Reminder job emails **every user with any roadmap** and no check-in today, including users who finished or are inactive. It runs sequentially inside one HTTP request. Brevo's free 300/day cap is hit past ~250 users. The cron secret is a URL query parameter, so it appears in logs. | **H at scale** | `reminderController.js` |
| A8 | Paystack `fetch` calls have no timeout. | L | `utils/paystack.js` |
| A9 | No `GET /health`. Logs are unstructured `console.*`. | L | `server.js` |
| A10 | Rate limiter is per-process memory. Fine for 1 instance, wrong for 2+. | L now | `middleware/security.js` |
| A11 | Voice is **browser speech recognition only** (`webkitSpeechRecognition`): it does nothing on Firefox, is unreliable on iOS Safari, and Chrome sends the audio to Google. The mentor has **no voice at all** and there is **no text-to-speech**. "Voice" is the product name but the feature is thin. | **H (product)** | `dashboard.ejs:90`, `roadmap.ejs:225` |
| A12 | Onboarding does not capture **hours per week**. The level comes only from the SWE assessment; the other tracks default to `foundation`. | M (product) | — |
| A13 | Founder admin view is missing. Tutors have `/teacher`, but cross-bootcamp revenue owed and at-risk students live only in `scripts/ledger.js` (CLI). There is no "at-risk" flag. | M | — |
| A14 | No events table, so a retention mechanic can't be added cleanly later. | L | — |
| A15 | Mentor memory: the last 6 messages × 800 chars, no rolling summary. Context grows with neither cost nor quality control past ~6 turns. | L | `mentorService.js` |
| A16 | Missing indexes: `assessments(user_id, track_id)`, `checkins(roadmap_id, checkin_date)`, `checkins(checkin_date)` (reminders). `roadmaps(user_id)` was added on the Course Library branch. | M | `db/schema.sql` |
| A17 | The roadmap page heading block (eyebrow + h1) renders twice. | L | `roadmap.ejs:39–47` |
| A18 | Repo clutter: root `preview-*.html`, `docs/superpowers/`. | L | — |
| A19 | `GET /pay/callback` grants access after a **server-to-server verify** with Paystack (not by trusting the redirect). This is Paystack's documented pattern and safe, but the brief says "entitlements only from verified webhooks". Decision in PLAN §0. | Info | `cohortController.js:136` |

## 3. Patterns and conventions to follow

- **Naming:** camelCase files and functions; `xController.js`, `xModel.js`, `xRoutes.js`; snake_case SQL columns; plural tables.
- **Layering:** routes are thin; one rate limiter per state-changing route; POST for every side effect.
- **DB access:** the shared `pool` from `config/db.js`; one model module per table group; explicit `BEGIN/COMMIT` with `FOR UPDATE` for money and queues; idempotency through UNIQUE keys plus `ON CONFLICT`.
- **Migrations:** an idempotent `db/<area>.sql` applied by `scripts/migrate<Area>.js`, registered in `scripts/migrate.js`. `IF NOT EXISTS` and `DO $$ … EXCEPTION WHEN duplicate_object` for constraints.
- **Money:** integer kobo; only `paymentModel.settlePayment` changes paid state. Prices live in the DB.
- **Gating:** only `canUse()` in `utils/entitlements.js`.
- **AI:** per-user caps in `ai_usage`; an env-var model name; timeout; fallback reply; idempotency key; a `*_MOCK=1` switch for tests.
- **Errors:** controllers `try/catch` AI and external calls and show a friendly page or JSON error code; the central 500 handler catches everything else; no stack traces to users.
- **Tests:** add HTTP-level checks to `scripts/cohort-test.js` for every money, access or AI path, and render cases to `scripts/smoke-test.js`.
- **Docs and rules:** `docs/PRD.md` (product rulebook, §15), `CLAUDE.md`, `docs/COHORTS.md` (deploy), ADRs in `docs/adr/`.

Patterns I'd change (proposed in PLAN, not silently forked): hand-rolled headers → `helmet` with CSP; hand-written input checks → `zod` schemas per route; direct Gemini SDK calls in 4 modules → one `services/llm.js`.
