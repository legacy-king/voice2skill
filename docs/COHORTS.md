# Cohorts, payments & AI mentor (pilot build)

Product spec, pricing, costs and roadmap: see [PRD.md](PRD.md).

What this adds on top of the original app (EJS/Express is unchanged for existing free users):

| Feature | Where |
|---|---|
| Bootcamps, cohorts, invite codes, memberships | `db/cohorts.sql`, `models/cohortModel.js` |
| Join by code, pay with Paystack, renew | `/join`, `/pay/:cohortId`, `/pay/callback`, `controllers/cohortController.js` |
| Paystack webhook (source of truth for payment) | `POST /webhooks/paystack` |
| Entitlements (`canUse(state, feature)`) | `utils/entitlements.js` |
| AI mentor chat grounded in the tutor's syllabus | `/mentor`, `utils/mentorService.js` |
| Teacher dashboard (roster, stuck students, earnings, syllabus editor) | `/teacher`, `/teacher/cohorts/:id` |
| Revenue-share ledger | `scripts/ledger.js` |
| Premium (individual, ₦6,000 / 30 days): AI coach + mentor | `POST /premium`, built-in cohort `kind = 'premium'` seeded by `db/cohorts.sql` |
| AI mentor carries the tutor's name | `cohorts.mentor_name` (teacher cohort settings) |

Free users keep the roadmap + daily check-ins (type or speak), but **no AI**: check-ins get the template coach reply. AI coach and mentor need Premium or a bootcamp.

Change the Premium price with SQL (no deploy): `UPDATE cohorts SET price_kobo = 600000 WHERE kind = 'premium';`

## Deploy checklist

1. **Database:** `npm run migrate` (now includes `migrateCohorts.js`; idempotent).
2. **Render env vars:** see `.env.example`. New ones: `APP_URL=https://voice2skill.com`, `PAYSTACK_SECRET_KEY`, optional `MENTOR_MODEL`, `MENTOR_DAILY_LIMIT` (default 40), `MENTOR_MONTHLY_LIMIT` (default 300; keep it low, it is the profit guardrail, see PRD 5.4), `AUTH_RATE_MAX`.
   Also: `SUPPORT_EMAIL` (shown on privacy/terms and the landing page), `PREMIUM_DAILY_LIMIT` (default 10).
   **Gemini billing must be ON** for the project behind `GEMINI_API_KEY`: the privacy policy promises student text is only sent to the paid tier (not used for training).
3. **Paystack:** create an account, start with the TEST secret key (`sk_test_...`). In the dashboard set the webhook URL to `https://voice2skill.com/webhooks/paystack`. Run a test payment with Paystack's test card before going live, then swap in the live key.
4. **Register the tutor:** he signs up and verifies his email, then you run
   `node scripts/createOrg.js "His Bootcamp" his@email.com 20 net`
   (20% share, calculated on the amount after Paystack fees; use `gross` to calculate before fees). He then opens `/teacher`, creates a cohort, pastes his syllabus, and shares the code.
5. **Payouts:** pay the bootcamp by bank transfer on a schedule, then record it: `node scripts/ledger.js payout <orgId> <naira> "note"`. `node scripts/ledger.js` shows what is owed.
6. **Render:** upgrade the web service from Free to the $7 instance before the first paying cohort, otherwise students wait 50s+ on cold starts.

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
