# Voice2Skill — Pilot release: deploy checklist

**Release:** everything on `release/pilot` (all commits on top of `main`): VOICE2-001, cohorts and payments,
Course Library, LLM router, voice, cohort seats and the admin view, and security hardening.
**Prepared:** 15 Oct 2026. **Hosting:** Render web service · Neon Postgres · voice2skill.com.

Work top to bottom. Every box is something a person has to do; the code can't do it for you.

---

## 0. Must do before going live (summary)

These are the items that can cause real harm (data, money, legal, broken features) if skipped:

1. **Back up the Neon database** (create a branch) before running migrations. (§3.1)
2. **Groq: turn on Zero Data Retention** before any student uses AI or voice. The privacy policy says Groq keeps no content. (§1.1)
3. **Gemini key on a paid (billing-enabled) project.** The privacy policy promises the paid tier. (§1.2)
4. **Sign off the privacy policy changes** (AI providers, voice recordings). Founder, and ideally a lawyer. (§2)
5. **Paystack:** live secret key and webhook URL, and one real test payment before the first cohort pays. (§1.3)
6. **Render paid instance ($7)**, not Free. The background jobs (reminders, course generation) live in the web process, and Free sleeps. (§1.6)
7. **Run `npm run migrate` against production before the new code starts.** (§3.2)
8. **Test voice on a real iPhone (Safari) and an Android phone** after deploy. (§4)
9. **Generate, review and publish the Course Library.** Until a track×level is published, new roadmaps there still use per-user AI, Free users included. (§3.6)

---

## 1. Accounts and external settings

### 1.1 Groq (main AI provider: mentor, check-in coach, speech-to-text)
- [ ] Create an API key, then set it as `GROQ_KEY` in Render.
- [ ] Console → Data Controls → **Zero Data Retention: ON** (globally). Required by the privacy policy.
- [ ] Console → Limits: check the free-plan numbers for `openai/gpt-oss-120b` and `whisper-large-v3-turbo`. The docs list 30 req/min, 1,000 req/day and 8,000 tokens/min for chat, and 2,000 clips/day and 28,800 audio-seconds/day for Whisper, but label them as Developer-plan base limits. When Groq returns 429, the app falls back to paid Gemini (small cost, capped per student).

### 1.2 Google Gemini (fallback provider + Course Library generation)
- [ ] Use a key whose Google Cloud project has **billing enabled** (paid tier: prompts are not used for training). Set it as `GEMINI_KEY` (the old `GEMINI_API_KEY` still works).
- [ ] Optional: a budget alert in Google Cloud billing.
- [ ] Note: the Gemini fallback for **voice** (webm/mp4 audio through the OpenAI-compatible endpoint) has not been tested against the real API. If it fails, voice still works through Groq; check `node scripts/llmUsage.js` for `gemini stt` errors.

### 1.3 Paystack
- [ ] Start with the **test** secret key (`sk_test_…`) as `PAYSTACK_SECRET_KEY`.
- [ ] Dashboard → Settings → API Keys & Webhooks → Webhook URL: `https://voice2skill.com/webhooks/paystack`.
- [ ] After deploy, buy Premium with Paystack's test card. Confirm `/mentor?paid=1`, and in `/admin` that the payment appears.
- [ ] Switch to the **live** key only when the test payment works. Refunds are manual, in the Paystack dashboard.

### 1.4 Brevo (email)
- [ ] `BREVO_API_KEY`, and `BREVO_SENDER_EMAIL` set to a verified sender on voice2skill.com.
- [ ] DNS: authenticate the domain (DKIM records from Brevo). **SPF:** a domain may have only one SPF TXT record. Merge Brevo's `include:` into the existing Namecheap forwarding SPF record instead of adding a second one.
- [ ] Free plan = 300 emails/day. Reminders are capped at `REMINDER_DAILY_CAP=250` to leave room for verification and reset emails.

### 1.5 Neon (database)
- [ ] Use the **pooled** connection string (host contains `-pooler`) as `DATABASE_URL`. The app uses no session-level features, so transaction pooling is safe.
- [ ] Keep `DATABASE_SSL` **unset** in production (SSL on).

### 1.6 Render (web service)
- [ ] Instance type: **Starter ($7) or higher**. Free sleeps after inactivity, which stops in-process jobs and slows the first request by 50s+.
- [ ] Build command: `npm ci` · Start command: `node server.js` · Node: 20+ (`engines` in package.json).
- [ ] **Health check path: `/health`** (returns only `{"ok":true}` when the app and DB answer).
- [ ] Optional, recommended: **Pre-Deploy Command `npm run migrate`** (paid instances). Migrations are idempotent and run before the new code goes live. Otherwise run them by hand (§3.2).

### 1.7 Daily reminder cron (cron-job.org or similar)
- [ ] Change the job to: `GET https://voice2skill.com/api/send-reminders` with the header **`X-Cron-Secret: <CRON_SECRET>`** (no `?key=` in the URL).
- [ ] When that works (the response is `202 {"queued":true,…}`), set `CRON_ALLOW_QUERY_KEY=0` in Render.
- [ ] Schedule: once a day, e.g. 18:00 Lagos (17:00 UTC).

---

## 2. Sign-offs (founder)

- [ ] **Privacy policy** (`/privacy`, updated 15 Oct 2026):
  - Groq is the main AI provider, with zero data retention. Gemini's paid service is the fallback.
  - No names or emails are sent to AI.
  - Voice recordings go to Groq/Gemini only for transcription and are not stored; this applies on every plan, including Free.
  - The browser's own speech recognition may be used as a fallback.
  - Read-aloud happens on the device.
  - Founder sign-off required (CLAUDE.md); a lawyer review is recommended.
- [ ] **Terms** (`/terms`): no change needed for this release. Check it still matches.
- [ ] **Tutor agreement** (from `docs/COHORTS.md`): share % and basis, payout schedule, data ownership, refunds. In writing, before money moves.
- [ ] Decide: may a student join more than one bootcamp? (Today: yes. The signup cohort is recorded for attribution only.)

---

## 3. Deploy steps (in order)

### 3.1 Back up
- [ ] Neon console → Branches → **create a branch from `main` now** (e.g. `pre-pilot-2026-10-15`). It's an instant copy you can restore from.

### 3.2 Environment and migrations
- [ ] In Render, set the env vars from §5 (at least everything marked **required**). Saving env vars triggers a deploy of the *current* code. That's fine: the new variables are ignored by the old code.
- [ ] Run the migrations against production **before** the new code starts. Either:
  - use Render's Pre-Deploy Command (`npm run migrate`), or
  - run them from a trusted machine with the production URL, from a checkout of `release/pilot`:
    ```bash
    DATABASE_URL='<neon pooled url>' npm run migrate
    ```
    They're idempotent (safe to re-run) and additive: new tables and columns, `roadmaps.content` becomes nullable, and existing rows aren't rewritten. Existing accounts stay verified.
  - Verified on 15 Oct against a copy of `main`'s schema with production-shaped data: an old user (bcrypt-10 password, per-user roadmap, check-in history) logged in, kept their roadmap and progress, checked in, and had their hash upgraded to cost 12.

### 3.3 Merge and deploy
- [ ] Merge the PR `release/pilot → main`. Render auto-deploys `main`.
- [ ] Render shows the deploy healthy (the `/health` check passes).

### 3.4 Smoke test (5 minutes, on the live site)
- [ ] `https://voice2skill.com/health` → `{"ok":true}`.
- [ ] Landing page loads with fonts and animations. DevTools console shows **no CSP errors**.
- [ ] Sign up with a new email → the verification email arrives (Brevo) → verify → dashboard.
- [ ] Speak a goal (mic) → text appears → match a track → roadmap appears.
- [ ] Daily check-in (type, then try voice) → template coach reply (Free).
- [ ] Buy Premium with the Paystack **test** card → mentor opens → ask a question → the reply streams in → Listen works.
- [ ] Log out, log in. Forgot password → the email arrives → reset works → the link can't be reused.

### 3.5 Admin, bootcamp, cron
- [ ] Make yourself admin: `DATABASE_URL='<prod>' node scripts/makeAdmin.js you@voice2skill.com` → open `/admin`.
- [ ] Register the tutor (after they sign up and verify): `node scripts/createOrg.js "<Bootcamp>" <tutor-email> 20 net`. The tutor opens `/teacher` and creates the cohort, optionally with **seats** and a **code expiry date**.
- [ ] Trigger the reminder cron once by hand (with the header) → `202`. Then `node scripts/llmUsage.js` and the server logs show `Reminder run finished`.

### 3.6 Course Library (removes per-user AI from roadmap creation)
- [ ] Generate drafts: `DATABASE_URL='<prod>' node scripts/courses.js generate --all`. This is 15 plans × 8 router calls (task `course`: Gemini → Mistral → Groq → OpenRouter). Expect a few dollars on paid Gemini.
- [ ] Review each draft: `node scripts/courses.js show <versionId> 1` (week by week).
- [ ] Publish the good ones: `node scripts/courses.js publish <versionId>`. `node scripts/courses.js list` shows the status.
- [ ] Until all 15 are published, roadmaps for unpublished track×levels fall back to per-user AI. Free users are included (PRD 4.1 rollout gap).
- [ ] **Rollback note:** after a course is published, new roadmaps reference it (`content` NULL). The *old* code can't read those, so don't publish until you're sure you won't roll back the code.

---

## 4. Real-device checks (can't be automated here)

- [ ] **iPhone, Safari:** goal mic, check-in mic, mentor Speak. Allow the microphone → record 5 s → "Uploading…" → text appears. Recording uses `audio/mp4` there.
- [ ] **Android, Chrome:** same three, plus Listen/Stop on a mentor reply.
- [ ] Deny the microphone once: the app says the mic is blocked and puts the cursor in the text box.
- [ ] Slow network: Chrome DevTools "Slow 4G". The upload percentage moves, and on a failure **Retry** reuses the same clip.

---

## 5. Environment variables (all of them)

**Required** = the feature is broken or unsafe without it. Defaults apply when unset.

### Core
| Variable | Required | Value / default | Notes |
|---|---|---|---|
| `DATABASE_URL` | **yes** | Neon **pooled** URL | |
| `SESSION_SECRET` | **yes** | long random string | Server refuses to start in production without it. |
| `NODE_ENV` | **yes** | `production` | Turns on secure cookies, HSTS, upgrade-insecure-requests and the mock guards. |
| `APP_URL` | **yes** | `https://voice2skill.com` | Email links, payment callback, canonical tags. Default is the old onrender URL. |
| `SUPPORT_EMAIL` | yes | `support@voice2skill.com` | Privacy/terms and Organizations contact. |
| `PORT` | no | set by Render | |
| `PG_POOL_MAX` | no | 10 | DB connections per process. |
| `DATABASE_SSL` | **no — leave unset** | | `false` is for a local Postgres only. |

### AI (LLM router, `config/llm.js`)
| Variable | Required | Value / default | Notes |
|---|---|---|---|
| `GROQ_KEY` | **yes** | Groq key (ZDR on) | Mentor, coach, voice. |
| `GEMINI_KEY` (or `GEMINI_API_KEY`) | **yes** | paid-tier key | Fallback; Course Library generation. |
| `MISTRAL_KEY` | no | | Used for student text only with `MISTRAL_NO_TRAINING=1` **and** after naming Mistral in the privacy policy. |
| `MISTRAL_NO_TRAINING` | no | unset | Set to `1` only after turning off training in the Mistral console. |
| `OPENROUTER_KEY`, `LLM_MODEL_OPENROUTER` | no | | Course Library generation only (no personal data). |
| `LLM_ROUTE_<TASK>` | no | see config | Tasks: `mentor`, `checkin`, `roadmap`, `course`, `stt`. |
| `LLM_MODEL_<PROVIDER>[_<TASK>]` | no | `openai/gpt-oss-120b`, `gemini-3.6-flash`, Whisper `whisper-large-v3-turbo` | `MENTOR_MODEL` still sets the Gemini mentor model. |
| `LLM_TIMEOUT_MS` | no | 20000 | Per attempt, chat tasks. `LLM_TIMEOUT_<TASK>_MS`, `LLM_MAX_TOKENS_<TASK>` per task. |
| `MENTOR_DAILY_LIMIT` | no | 40 | Bootcamp students per day. |
| `PREMIUM_DAILY_LIMIT` | no | 10 | Premium per day. |
| `MENTOR_MONTHLY_LIMIT` | no | 300 | Shared monthly cap (profit guardrail, PRD 5.4). |
| `STT_DAILY_LIMIT_FREE` / `_PAID` | no | 20 / 60 | Voice clips per user per day. |
| `STT_MAX_BYTES` | no | 3145728 | Max upload (~60 s of audio). |
| `COURSE_RETRIES` | no | 3 | Extra retries per generated week. |
| `COURSE_CACHE_SIZE` | no | 50 | Published course versions kept in memory. |

### Email, payments, reminders
| Variable | Required | Value / default | Notes |
|---|---|---|---|
| `BREVO_API_KEY`, `BREVO_SENDER_EMAIL` | **yes** | | |
| `PAYSTACK_SECRET_KEY` | **yes** | `sk_test_…` first, then `sk_live_…` | Also verifies webhook signatures. |
| `CRON_SECRET` | **yes** | long random string | Sent by the cron as `X-Cron-Secret`. |
| `CRON_ALLOW_QUERY_KEY` | no | allowed until set to `0` | Set `0` once the cron uses the header. |
| `REMINDER_ACTIVE_DAYS` | no | 7 | Only learners active within this window get reminders. |
| `REMINDER_DAILY_CAP` | no | 250 | Reminder emails per day. |

### Security and tuning
| Variable | Required | Value / default | Notes |
|---|---|---|---|
| `AUTH_RATE_MAX` | no | 60 | Signup/login/reset attempts per IP per 15 min (a class shares one IP). |
| `LOGIN_MAX_PER_EMAIL` | no | 10 | Failed logins per account per 15 min before that account is locked. |
| `EMAIL_MAX_PER_ADDRESS` | no | 5 | Reset/verification emails per address per hour. |
| `BCRYPT_COST` | no | 12 | Minimum 12. |
| `CORS_ORIGINS` | no | empty | Only for a future frontend on another origin. |
| `AT_RISK_DAYS` | no | 3 | "At risk" / "needs a nudge" threshold. |
| `JOB_POLL_MS`, `JOB_STALE_MINUTES`, `JOBS_DISABLED` | no | 15000, 15, unset | In-process job runner. |

### Never in production
`PAYSTACK_MOCK`, `MENTOR_MOCK`, `COURSE_MOCK` (the server refuses to start with them), `EMAIL_MODE=log`, `DATABASE_SSL=false`.

---

## 6. If something goes wrong

- **App won't start:** Render logs are JSON lines; search for `"level":"error"`. A missing `SESSION_SECRET` or a mock flag set in production stops startup on purpose.
- **AI replies failing:** run `node scripts/llmUsage.js` (with the production URL). Rising `429` means a free quota ran out; `401` means a bad key (no failover on 401 by design). Students see a friendly message and their message budget is refunded.
- **Payments:** `node scripts/ledger.js`; the `/admin` totals; Paystack dashboard → webhook delivery logs.
- **Roll back the code:** Render → Deploys → roll back to the previous deploy. The schema changes are additive, so the old code runs on the new schema. The exception is roadmaps that point at a published Course Library version, so don't publish courses until you're sure.
- **Roll back the data:** restore from the Neon backup branch (§3.1).

## 7. Known limitations in this release

- No unsubscribe link for reminder emails yet.
- Login says "no account found" vs "wrong password" (reveals whether an email is registered). The per-email lock limits guessing.
- Rate-limit counters are in memory: correct for one Render instance; a second instance needs a shared store first.
- Inline `style=""` attributes are still allowed by the CSP; scripts are fully locked to our own files.
- `scripts/sit-test.js` targets the database in `.env`. Run it only against a disposable copy.
- `npm audit` (production deps): 0. Dev-only `nodemon` has advisories that need a major upgrade.
