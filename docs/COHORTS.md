# Cohorts, payments & AI mentor (pilot build)

Product spec, pricing, costs and roadmap: see [PRD.md](PRD.md).

What this adds on top of the original app (EJS/Express is unchanged for existing free users):

| Feature | Where |
|---|---|
| Bootcamps, cohorts, invite codes, memberships | `db/cohorts.sql`, `models/cohortModel.js` |
| Join by code, pay with Paystack, renew | `/join`, `/pay/:cohortId`, `/pay/callback`, `controllers/cohortController.js` |
| Paystack webhook (source of truth for payment) | `POST /webhooks/paystack` |
| Entitlements (`canUse(state, feature)`) | `services/entitlements.js` |
| AI mentor chat grounded in the tutor's syllabus | `/mentor`, `services/mentorService.js` |
| Teacher dashboard (roster, stuck students, earnings, syllabus editor) | `/teacher`, `/teacher/cohorts/:id` |
| Revenue-share ledger | `scripts/ledger.js` |
| Premium (individual, ₦6,000 / 30 days): AI coach + mentor | `POST /premium`, built-in cohort `kind = 'premium'` seeded by `db/cohorts.sql` |
| AI mentor carries the tutor's name | `cohorts.mentor_name` (teacher cohort settings) |

Free users keep the roadmap + daily check-ins (type or speak), but **no AI**: check-ins get the template coach reply. AI coach and mentor need Premium or a bootcamp.

Change the Premium price with SQL (no deploy): `UPDATE cohorts SET price_kobo = 600000 WHERE kind = 'premium';`

## Deploy checklist

1. **Database:** `npm run migrate` (now includes `migrateCohorts.js` and `migrateCourses.js`; idempotent).
   **Course Library (ADR-001):** until a track x level has a published plan, new roadmaps for it still use per-user AI, Free users included. Run `node scripts/courses.js generate --all` (8 Gemini calls per plan, 15 plans), review each draft with `node scripts/courses.js show <versionId> [week]`, then `node scripts/courses.js publish <versionId>`. `node scripts/courses.js list` shows what is published.
2. **Render env vars:** see `.env.example`. New ones: `APP_URL=https://voice2skill.com`, `PAYSTACK_SECRET_KEY`, optional `MENTOR_MODEL`, `MENTOR_DAILY_LIMIT` (default 40), `MENTOR_MONTHLY_LIMIT` (default 300; keep it low, it is the profit guardrail, see PRD 5.4), `AUTH_RATE_MAX`.
   Also: `SUPPORT_EMAIL` (shown on privacy/terms and the landing page), `PREMIUM_DAILY_LIMIT` (default 10).
   **AI providers (LLM router, `config/llm.js`):** set `GROQ_KEY` and turn on **Zero Data Retention** in the Groq console (Data Controls) **before** going live: the privacy policy says Groq keeps no content. Set `GEMINI_KEY` (or the old `GEMINI_API_KEY`) to a key whose project has **billing ON** (paid tier, not used for training). Mistral and OpenRouter are optional and off for student text by default. Check provider health with `node scripts/llmUsage.js` (429s mean a free quota ran out). Voice input uses the same `GROQ_KEY` (Whisper); caps `STT_DAILY_LIMIT_FREE` / `STT_DAILY_LIMIT_PAID`. **After deploy, test voice on a real iPhone (Safari) and an Android phone** (record, upload, text appears), since the automated tests can't drive a real microphone.
3. **Paystack:** create an account, start with the TEST secret key (`sk_test_...`). In the dashboard set the webhook URL to `https://voice2skill.com/webhooks/paystack`. Run a test payment with Paystack's test card before going live, then swap in the live key.
4. **Register the tutor:** he signs up and verifies his email, then you run
   `node scripts/createOrg.js "His Bootcamp" his@email.com 20 net`
   (20% share, calculated on the amount after Paystack fees; use `gross` to calculate before fees). He then opens `/teacher`, creates a cohort, pastes his syllabus, and shares the code.
   Optional per cohort: **seats** (a student who joined holds a seat, paid or not; renewals never need a new seat) and a **code expiry date** (end of that day, Lagos time; existing students can still pay and renew). Students can also sign up straight from the invite link (`/join?code=…` → signup with the code filled in); they join the cohort when they verify their email.
5. **Your admin view:** sign up, verify, then `node scripts/makeAdmin.js you@voice2skill.com`. `/admin` shows every bootcamp, what is owed to each, all cohorts (seats, expired codes, at-risk count) and each roster with streaks. Read-only; never shows notes or chats. "At risk" = paid access and no check-in for `AT_RISK_DAYS` (default 3) days.
6. **Payouts:** pay the bootcamp by bank transfer on a schedule, then record it: `node scripts/ledger.js payout <orgId> <naira> "note"`. `node scripts/ledger.js` shows what is owed.
7. **Render:** upgrade the web service from Free to the $7 instance before the first paying cohort, otherwise students wait 50s+ on cold starts.

## Things to agree with the tutor in writing before money moves

- Share % and basis (net of Paystack fees vs gross), and payout schedule.
- Who owns the syllabus content and student data; what happens to students if you part ways.
- Refund policy (there is no refund flow in the code; do it manually in Paystack).
- Privacy: students are told their tutor sees name, email and check-in counts (never notes). Add a privacy policy/terms page before launch.

## Known limits (deliberate, for a pilot)

- **No auto-recurring billing.** A student pays for `access_days` (default 30) and re-pays to renew; the join page shows "Renew". Recurring charges need Paystack Plans/subscriptions: build once the model is proven.
- **Revenue share is a ledger + manual payout**, not automatic Paystack split payments (subaccounts). Switch once the numbers are trusted.
- **Rate limiter is in process memory** (fine for one instance; use Redis/Postgres if you ever run two).
- **Mentor model:** defaults to `gemini-3.6-flash` (the model your app already uses). Set `MENTOR_MODEL` to a cheaper Flash-Lite id after checking its exact name in Google AI Studio and comparing quality.
- Signup/login limit is 60 per IP per 15 min (`AUTH_RATE_MAX`), raised from 20 because a whole class shares one wifi IP.

## Tests

`npm test` — original template smoke tests (no DB).
`npm run test:cohorts` — end-to-end (the server refuses to start with `PAYSTACK_MOCK`/`MENTOR_MOCK` set when `NODE_ENV=production`): boots the server against a DISPOSABLE Postgres (set `DATABASE_URL`, `DATABASE_SSL=false`), uses mock Paystack/AI, covers join, paywall, signed webhooks, replay + concurrency, expiry, mentor caps/idempotency, teacher access control, ledger. **Never point it at your production database.**
