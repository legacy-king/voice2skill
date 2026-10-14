# Voice2Skill — Product Requirements Document (PRD)

| | |
|---|---|
| **Owner** | Kingsley "Kaay" Ivom |
| **Status** | Living document. v1.0, 14 Oct 2026 |
| **Live site** | https://voice2skill.com (Render web service `voice2skill`, Neon Postgres) |
| **Repo** | github.com/legacy-king/voice2skill |
| **Audience** | The founder, the bootcamp partner, and Claude Code (which builds from this file) |

> **How to read this.** Every claim is tagged where it matters:
> **[Built]** exists in the code and is tested. **[Planned]** is a requirement not yet built.
> **[Verified]** was checked against an official page on 14 Oct 2026. **[Assumption]** is a guess to be tested. Prices and limits change; re-check anything tagged [Verified] before committing money.

---

## 1. Summary

**Voice2Skill is an AI study mentor that keeps self-taught and bootcamp learners on track.** A learner states a goal (typed or spoken), gets a structured 8-week plan with daily lessons, quizzes and projects, checks in daily, and gets coaching from an AI mentor that knows their plan, and, for bootcamp students, their tutor's syllabus.

**Why it exists.** Free learning material is everywhere; structure and accountability are not. The founder built it because he needed a mentor while self-teaching and often didn't have one.

**How it makes money.** Bootcamps and tutors bring cohorts of students. Each student pays a monthly fee for the AI mentor and tutor-visible progress; the bootcamp earns a revenue share. Individuals can also subscribe directly. Free users get the structured plan through free resources and daily check-ins (no AI) as the acquisition funnel; learning with AI is paid: Premium for individuals (₦6,000/month) or through a bootcamp.

**First customer.** A tutor who proposed the idea and plans to start a bootcamp; students use Voice2Skill after class to keep learning daily. Target: working pilot within about two weeks.

**The single most important design rule: AI cost per user must stay a small, capped fraction of revenue per user.** Everything in sections 5–7 exists to enforce that.

---

## 2. Problem and opportunity

| Who | Pain |
|---|---|
| Self-taught learners | Don't know what to learn next, lose consistency, no one to ask. |
| Bootcamp students | Class ends, questions don't. Motivation drops between sessions. |
| Tutors / bootcamp owners | Can't see who is falling behind; can't be available 24/7; want a product to bundle and a recurring revenue line. |

**Opportunity.** Tutors have the audience and the curriculum; Voice2Skill has the daily accountability loop and the AI. The tutor's syllabus makes the mentor *his*, not generic ChatGPT, which is the product's defensible edge for a cohort.

---

## 3. Users and personas

1. **Individual learner ("Free" → "Premium")**: self-taught, often on mobile and limited data, price-sensitive, wants a plan and a nudge.
2. **Bootcamp student ("Cohort")**: joins with a tutor's code, pays the cohort price, expects the mentor to know what was taught this week.
3. **Tutor / bootcamp owner ("Teacher")**: creates cohorts, pastes a syllabus, shares a code, watches progress, gets paid a share.
4. **Platform admin (the founder)**: registers bootcamps, sets revenue share, records payouts, watches costs.

---

## 4. Product pillars

### 4.1 Courses (the Course Library)
- A **Track** (Software Engineering, UI/UX, Data Analysis, Digital Marketing, Cybersecurity) has **Levels** (foundation, builder, professional), and each level is an **8-week plan** of 56 daily items: task, lesson (300–450 words), code example where relevant, quiz question, resource link, video search phrase, plus one **weekly project**. **[Built]**
- **Course Library [Built, ADR-001]:** each track×level plan is generated **once** (background job, one Gemini call per week), reviewed, published, and stored versioned in Postgres (`courses`, `course_versions`). A new roadmap for a published track×level **references** that version (`roadmaps.course_version_id`, no copy) and is created with **0 AI calls**, for every tier. Personalization is a thin layer: the assessment level picks the course (tracks without an assessment use `foundation`), and a templated, goal-aware intro is shown on the roadmap. **Rollout gap:** until a track×level has a published version, roadmap creation falls back to the old per-user AI generation (with the exact-goal cache), Free users included; the founder must generate, review and publish all 15 plans (`node scripts/courses.js`) to close it.
- **[Planned, Phase 2] Cohort courses:** generated **once per cohort** from the tutor's syllabus (paid tier, capped per org) and tutor-editable, reusing the same tables and job runner. Adaptive "what's next" is also planned.

### 4.2 Training (the daily loop)
- Daily check-in with free-text notes; one per day per roadmap. **[Built]**
- Streaks, "today's task", reminders by email (via an external cron hitting a secret URL). **[Built]**
- Capability assessment (8 questions → foundation / builder / professional) for Software Engineering. **[Built]**
- Voice goal input in the browser (Web Speech API, free; works in Chrome/Edge and limited elsewhere). **[Built]**
- **[Planned]** Quiz answers captured and scored; AI rubric feedback on weekly projects (capped); certificates of completion.

### 4.3 Mentoring
- **AI check-in coach:** after each check-in, a 3-part reply (acknowledgement, insight, next action) tuned to the learner's level; falls back to a template if the AI fails. **[Built]**
- **AI mentor chat:** grounded in the cohort syllabus plus the learner's current roadmap task; daily and monthly caps; idempotent. **[Built]**
- **Human tutor visibility:** roster with check-in counts, last check-in, and "needs a nudge" flag (paid student, 3+ days silent). **[Built]**
- **[Planned]** "Ask my tutor": the mentor can forward an unresolved question to the tutor; tutor announcements to the cohort; weekly digest email to the tutor.

### 4.4 Bootcamp / organization tools
- Organizations (bootcamps), cohorts, invite codes (8 chars, no ambiguous letters), syllabus editor, price and access-days per cohort, open/closed toggle. **[Built]**
- Transparent earnings panel for the tutor (collected, share, paid out, owed). **[Built]**
- **[Planned]** Branding (logo/name on the student pages), multiple teachers per org, bulk seat purchase (Option B, see 5.3), CSV export.

### 4.5 Payments
- Paystack checkout in naira; webhook is the source of truth; browser callback also verifies server-side; both go through one idempotent settlement function. **[Built]**
- Manual renewal (student pays again for another period). **[Built]**
- **[Planned]** Recurring auto-charge (Paystack plans/subscriptions) and automatic revenue split (Paystack subaccounts), after the manual numbers are trusted.

---

## 5. Tiers, pricing and business model

### 5.1 Tiers

**The tier rule (founder decision, 14 Oct 2026): Free = free resources, no AI. Learning with AI is paid**: either Premium (individuals) or through a bootcamp, where the AI mentor carries the tutor's name. Prices live in the database (Premium: `cohorts` row with `kind = 'premium'`; bootcamps: set by the tutor), so a price change is an `UPDATE`, not a deploy.

| | **Free** | **Premium** (individual) | **Bootcamp** (cohort student) | **Organization** (bootcamp/school) |
|---|---|---|---|---|
| Price | ₦0 | **₦6,000 / 30 days** **[Built]** | Set by tutor, ~₦5,000–8,000/mo | Free in pilot; later flat fee (see 5.3); "Contact us" on the landing page |
| Structured 8-week plan (daily lesson, quiz, free resource, weekly project) | Yes | Yes | Yes (tutor's syllabus-based plan **[Planned]**) | n/a |
| Daily check-ins (type or speak) + streak + reminders | Yes | Yes | Yes | n/a |
| AI check-in coach | **No** — template reply, no AI call **[Built]** | Yes **[Built]** | Yes **[Built]** | n/a |
| AI mentor chat | **No** | 300 msgs/month, 10/day **[Built]** | 300 msgs/month, 40/day **[Built]** | n/a |
| Mentor identity | n/a | "Voice2Skill AI mentor", grounded in the learner's roadmap | "**[Tutor name]'s AI mentor**" (`cohorts.mentor_name`, default the tutor's account name), grounded in the tutor's syllabus; always says it is an AI **[Built]**. Tutor photo/avatar **[Planned]** | Tutor manages it |
| Project feedback (AI rubric) | No | 4 per month **[Planned]** | 4 per month **[Planned]** | n/a |
| Tutor sees progress | No | No | **Yes** (name, email, counts; never notes or mentor chats) | Yes |
| Access model | Always | 30 days per payment, manual renewal, no auto-charge | `access_days` per payment (default 30) | n/a |

**How Premium is built.** Premium is a built-in cohort (`kind = 'premium'`, owned by the platform organization "Voice2Skill", 0% revenue share), seeded by `db/cohorts.sql`. Buying it is `POST /premium`, which reuses the bootcamp checkout end to end: price from the DB, Paystack, signed webhook, idempotent `settlePayment()`, `access_until` extension. All gating lives in `canUse(state, feature)` in `utils/entitlements.js` (`ai_coach`, `mentor_chat`).

**Known gap:** the Course Library is built (ADR-001), so a Free user's plan costs 0 AI calls **once that track×level is published**. Until all 15 plans are published, an unpublished track×level still falls back to per-user AI generation on the Free tier (finding #1).

### 5.2 Revenue streams
1. **Cohort subscriptions (core, pilot).** Student pays; bootcamp earns a share (default 20% of the amount after Paystack fees; `net` or `gross` configurable per org).
2. **Individual Premium (₦6,000 / 30 days) [Built].** Direct-to-consumer; no share. Cheap to serve once the Course Library exists.
3. **Organization plan (later).** Flat monthly fee for branding, multiple teachers, analytics export, and/or bulk seat billing.
4. **Not now:** ads, employer placement fees, certificates for sale. Revisit with traction.

### 5.3 Who pays: Option A vs B
- **A (built):** each student pays with the bootcamp's code; bootcamp gets a share. Simplest; fits what the tutor described.
- **B (not built):** bootcamp pays per seat in bulk and hands out access. Needs seat inventory and invoicing.
- **Open risk:** students may be paying the bootcamp tuition *and* ₦5,000/mo. The tutor may prefer to bundle the mentor into tuition (Option B). **Ask him before scaling.**

### 5.4 Unit economics
**[Assumption] USD/NGN = 1,500** (re-check monthly). Paystack local fee **[Verified]**: 1.5% + ₦100, capped ₦2,000, ₦100 waived under ₦2,500. Share = 20% of the post-fee amount. AI model prices below are per-call at paid-tier list prices; the table excludes the roadmap (Course Library model) and includes 30 coach replies/month.

Your margin per paying student at **₦5,000/mo**, per month, after Paystack, bootcamp share and AI:

| Model for mentor chat | Typical use (60 msgs) | At 300-msg cap | At 600-msg cap |
|---|---|---|---|
| Gemini 3.6 Flash (current price $0.75/$3.75) | ₦3,421 (68%) | ₦2,071 (41%) | ₦384 (8%) |
| Gemini 3.6 Flash (**scheduled** price $1.50/$7.50) | ₦2,982 (60%) | ₦283 (6%) | **−₦3,092 (loss)** |
| Gemini 3.5 Flash-Lite ($0.30/$2.50) | ₦3,635 (73%) | ₦2,951 (59%) | ₦2,096 (42%) |
| Claude Haiku 5.5 ($0.10/$0.50) | ₦3,802 (76%) | ₦3,622 (72%) | ₦3,396 (68%) |

At ₦6,000/mo (Premium, no share, no bootcamp cut) margins are higher than the ₦5,000 cohort column above at every cap; at ₦8,000/mo margins rise to 33–77%.

**Findings:**
1. **The message cap is the real profit guardrail.** At the old default of 600 messages/month on Gemini 3.6 Flash after its scheduled price rise, a heavy student *loses* money. Set `MENTOR_MONTHLY_LIMIT=300` and use a Flash-Lite-class or Haiku-class model for chat. (Code default changes to 300 in this release.)
2. **Fixed monthly costs** (Section 6) are ₦12k (lean) to ₦84k (serious). At ₦5,000 and ~₦3,600 margin per student, **break-even is about 4 paying students (lean), 11 (growth), 23 (serious).** Software costs are not the risk; acquiring students is.
3. **Mentor model choice is a quality question as much as a cost question.** Test Flash-Lite and Haiku against the tutor's real syllabus questions before committing.

### 5.5 Revenue share mechanics
- Stored in kobo on every successful payment: `provider_fee_kobo`, `org_share_kobo`.
- `scripts/ledger.js` shows owed per bootcamp; payouts are bank transfers recorded with `scripts/ledger.js payout <orgId> <naira> "note"`.
- **Agree in writing before money moves:** share %, net vs gross basis, payout schedule, refund policy, content and data ownership, exclusivity, exit terms.

---

## 6. Cost model and free routes

### 6.1 Fixed monthly costs

| Item | Lean (pilot) | Growth | Serious | Notes |
|---|---|---|---|---|
| Render web service | **$7** | $7 | $25 | Free tier is for non-production; Render's docs say not to use it for production **[Verified]**. $7 plan = <1 CPU, 512 MB, no sleeping. |
| Database (Neon) | $0 (free) | ~$19 | ~$30 | Free: 100 CU-hours/project, scales to zero after 5 min **[Verified]**; Launch: $0.106/CU-hour + $0.35/GB, no monthly minimum **[Verified]**. Growth/Serious figures are **[Assumption]** (estimate for an always-warm instance). |
| Domain voice2skill.com | ~$1.25 | ~$1.25 | ~$1.25 | $10.98 first year; ~$14.98 renewal. |
| Email (Brevo) | $0 | $0 | paid tier | 300 emails/day free **[Verified]**. |
| Redis / queue | $0 (not needed) | $0 | $0 | Upstash free: 500K commands/mo, 250 MB **[Verified]**; Render Key Value free 25 MB **[Verified]**. |
| Monitoring | $0 | $0 | $0 | See 6.3. |
| **Total** | **≈ $8 (₦12k)** | **≈ $27 (₦41k)** | **≈ $56 (₦84k)** | |

### 6.2 Variable costs per paying student per month
- **Paystack:** ~₦175 on a ₦5,000 payment.
- **Bootcamp share:** ~₦965 (20% of ₦4,825).
- **AI:** ₦58–₦439 typical (60 msgs + 30 coach replies), up to ₦1,764 at a 600-msg cap on Flash-Lite. See 5.4.

### 6.3 Free routes: what to use, what to avoid

| Need | Free route | Limit / catch | Decision |
|---|---|---|---|
| **Course content generation** | Gemini API free tier **[Verified]**: Flash/Flash-Lite are "free of charge" | **Free-tier content may be used to improve Google products; paid is not [Verified].** Rate limits are shown only in AI Studio (not published on the docs page). | **Use free tier ONLY for one-time Course Library generation** (prompts contain no personal data). This turns the biggest AI cost into ~₦0. |
| **Anything with student text** (mentor chat, coach, check-ins) | none safely | Must be on the **paid** tier so student data is not used for training. | Pay; it's cheap (sec. 5.4). Enable billing on the Gemini project. |
| Cheaper/alternative LLM | Cloudflare Workers AI: 10,000 neurons/day free, then $0.011/1,000 **[Verified]**; e.g. gemma-4-26b $0.10/$0.30, gpt-oss-120b $0.35/$0.75 per M tokens **[Verified]** | Quality for tutoring unproven; neuron-to-request conversion not verified | Optional fallback/second source; **evaluate before use**. |
| Groq | Has a free plan | Free-plan limits could not be verified from the docs page | Don't depend on it until limits are confirmed. |
| Static frontend (Phase 2) | **Cloudflare Pages**: unlimited static requests, no commercial restriction, 500 builds/mo **[Verified, per a Sept 2026 comparison]** | | **Preferred** for the React build. |
| ❌ Vercel Hobby | free | **Non-commercial use only [Verified]** | **Do not use for this product.** |
| ❌ Render free web service | free | Sleeps after 15 min (~1 min wake); not for production **[Verified]** | Pilot demo only; $7 plan once students pay. |
| ❌ Render free Postgres | free | Expires 30 days after creation **[Verified]** | Stay on Neon. |
| Database | Neon free | CU-hours burn when Postgres is kept warm; session store + `touchLastActive` writes keep it awake | Fine for 12 users; expect Launch usage billing once a class uses it daily. |
| Alt DB | Supabase free: 500 MB, pauses after 1 week inactivity **[Verified]** | Pausing is bad for a daily product | Not recommended. |
| Email | Brevo free 300/day **[Verified]** | The reminder job currently emails every user who has a roadmap and no check-in today; at >~250 active users it will hit the daily cap | Fix the reminder query (Section 8) before a large cohort. Alt: Resend (free tier **not verified**). |
| Uptime pinger | cron-job.org (not verified in this research) | **UptimeRobot free is for hobby/non-profit only [Verified]** | Don't use UptimeRobot on a paid product. Prefer paying $7 for Render (no sleep) and use any free pinger only for *alerting*. |
| Speech input | Browser Web Speech API | Browser support varies; audio goes to the browser vendor | Already used. Keep as progressive enhancement. |
| Payments | Paystack: no monthly fee | 1.5% + ₦100. Flutterwave ~1.4% local **[per one comparison, unverified]** | Start with Paystack; revisit at volume. |
| Background jobs / queue | `pg-boss` or a plain jobs table **on Postgres** | None | Use instead of Redis until multi-instance. |
| Error tracking | Sentry free developer tier (**not verified**) | | Add in Phase 2. |

### 6.4 Cost-control rules (non-negotiable)
1. Generate shared content **once** (Course Library), never per user.
2. Hard per-user caps on every AI feature (daily + monthly), enforced atomically in the database. **[Built for mentor chat]**
3. Cap input size (syllabus truncated to 6,000 chars, last 6 messages, 1,000-char messages) and output size (700 tokens). **[Built]**
4. Model is an env var (`MENTOR_MODEL`) so it can be switched without a deploy of code.
5. Student-text prompts only on the paid AI tier.
6. Weekly cost review: total AI spend ÷ paying students must stay under 25% of net revenue per student, or tighten caps.
7. Idempotency keys on every paid action so retries and double-clicks cost nothing. **[Built for chat and payments]**

---

## 7. Architecture

### 7.1 As built today (Phase 1 — monolith)

```
 Browser ──HTTPS──> Render web service (Node 22, Express 5, EJS views)   voice2skill.com
                      │  sessions (express-session + connect-pg-simple)
                      │  CSRF (hidden field or X-CSRF-Token header), in-memory rate limiter
                      │
                      ├──> Neon Postgres  (users, tracks, assessments, roadmaps, checkins,
                      │                    coach_responses, session, organizations, cohorts,
                      │                    memberships, payments, org_payouts, ai_usage,
                      │                    mentor_messages)
                      ├──> Gemini API  (Course Library jobs, roadmap fallback, check-in coach, mentor chat)
                      ├──> Paystack    (checkout, webhook -> /webhooks/paystack)
                      └──> Brevo       (verification, reset, reminder emails)
 External cron ──GET /api/send-reminders?key=CRON_SECRET──> Render
```

Code layout: `routes/` → `controllers/` → `models/` (SQL) with `utils/` (mailer, AI services, entitlements, Paystack client, format) and `middleware/` (security headers, CSRF, rate limits, entitlements). Money is always integer kobo.

### 7.2 Target architecture (Phase 2–3)

```
 Browser ─> Cloudflare Pages (React + Vite, free)        voice2skill.com
              │ fetch(credentials, X-CSRF-Token)
              ▼
            Render web service (Express JSON API)        api.voice2skill.com
              ├─> Neon Postgres (+ Course Library tables, jobs table)
              ├─> AI provider(s) behind one `ai` module (model per feature)
              ├─> Paystack (checkout + webhooks; later plans + subaccounts)
              └─> Brevo / email
```
- Session cookie `domain=.voice2skill.com`, `sameSite=lax` (works because `api.` is same-site). CORS allow-list = frontend origin with credentials.
- The CSRF middleware already accepts the `X-CSRF-Token` header **[Built]**, so the split needs a `GET /api/csrf` endpoint, not a redesign.
- Mailer links and payment callbacks use `FRONTEND_URL` / `APP_URL`.
- **When to do the split:** after the first cohort is paying (decision recorded). It buys maintainability and a free static host, not revenue.

### 7.3 Course Library (the key Phase-2 change) **[Built, ADR-001]**
**Problem found in the code (before ADR-001):** `generateRoadmapContent` asks one Gemini call to emit the entire 8-week plan as JSON: 56 lessons of 300–450 words plus code, quizzes and projects, roughly **40,000 output tokens** **[Assumption: estimated from the prompt]**, with no `maxOutputTokens`, no retry, held inside a user's HTTP request. Consequences: ~₦150–₦450 per user at list prices (my earlier ₦72 estimate assumed 6,000 tokens and was **wrong**), long waits, risk of truncated/invalid JSON, and a "we're at capacity" page when it fails.

**Fix (built; see `docs/adr/ADR-001-course-library.md`):**
- Tables (`db/courses.sql`, `scripts/migrateCourses.js`, part of `npm run migrate`): `courses` (track, level, optional `cohort_id`, title; unique per track×level), `course_versions` (version, status `draft|published|retired`, one JSONB plan, model; one published version per course; a DB trigger makes published/retired content immutable), `jobs`, and `roadmaps.course_version_id` (content may be NULL when it is set). Indexes `roadmaps(user_id)` and `roadmaps(course_version_id)`.
- Generation (`utils/courseGenerator.js`) runs as a background job, never in a request: one Gemini call per week (8 per plan), JSON response schema, `COURSE_MAX_OUTPUT_TOKENS`, `COURSE_TIMEOUT_MS`, `COURSE_RETRIES` with backoff, model `COURSE_MODEL`. Finished weeks are saved as job progress, so a retried job resumes instead of paying again. The plan must be exactly 8 weeks × 7 days before it is saved as a draft, and again before it is published.
- Job runner (`utils/jobRunner.js`) inside the web process: `FOR UPDATE SKIP LOCKED`, one job at a time, heartbeat + stale-job reclaim, exponential backoff, `max_attempts`, idempotent enqueue (`dedupe_key`). `JOBS_DISABLED=1` keeps a process out of the queue.
- Founder workflow: `node scripts/courses.js generate --all` (or `generate <track> <level>`) → `show <versionId> [week]` to review → `publish <versionId>`. `list` shows every course, version, status and how many roadmaps use it.
- Read path: `roadmapModel` fills `content` from the version when a row's own content is NULL, so the roadmap page, check-ins, the mentor's current task and `migrateRoadmaps.js` work unchanged. Published versions are cached in process memory (LRU, `COURSE_CACHE_SIZE`, default 50), deep-frozen.
- Versions: a roadmap stays pinned to the version it started on; publishing a new version retires the old one and gives new roadmaps the new one. Every version is 8×7, so check-in day numbers never shift.
- `selectTrack`: published version for track×level → library roadmap, 0 AI calls, templated intro. Otherwise the old per-user path runs (rollout fallback; to be removed once all 15 are published).
- Tier: library prompts contain no personal data (track name/description and level only). The ADR recommends the paid tier for predictability; it uses the same `GEMINI_API_KEY`.

### 7.4 Data model (current; ✓ = migrated)
`users` (+`role`) · `tracks` · `assessments` · `roadmaps` · `checkins` · `coach_responses` · `session` ·
`organizations`(owner, revenue_share_pct, share_basis) ✓ · `cohorts`(org, invite_code, price_kobo, access_days, curriculum, active) ✓ · `memberships`(user, cohort, role teacher|student, status, access_until) ✓ · `payments`(reference UNIQUE, amount_kobo, fee, org_share, status) ✓ · `org_payouts` ✓ · `ai_usage`(user, day, kind, count) ✓ · `mentor_messages`(client_msg_id UNIQUE per user, reply_to) ✓.
`courses` ✓ · `course_versions`(status draft|published|retired, JSONB content, immutable once published) ✓ · `jobs`(kind, payload, status, attempts, run_after, dedupe_key) ✓ · `roadmaps.course_version_id` ✓.
**Planned:** `subscriptions` (recurring), `announcements`, `tutor_questions`, `email_log`(sent-per-day idempotency), `audit_log`.

### 7.5 Key flows
1. **Join + pay:** `POST /join` (code) → pending membership → `POST /pay/:cohortId` → Paystack → (a) webhook `charge.success` and/or (b) `/pay/callback` verify → `settlePayment()` (row lock, amount match, idempotent) → membership active, `access_until` extended by `access_days` from the later of now or current expiry. **[Built, 67 e2e checks]**
2. **Mentor message:** JSON `POST /mentor/message {message, clientMsgId}` → entitlement check → replay check → atomic usage bump + cap check → insert user msg → AI call (25 s timeout) → insert reply; on failure undo message and refund usage. Orphans older than 60 s are recovered. **[Built]**
3. **Tutor view:** roster joins memberships → users → check-in counts; never selects note text. **[Built]**
4. **Daily reminder:** external cron → secret URL → email users without a check-in today. **[Built, needs fixes, see Section 8]**

### 7.6 Caching, idempotency, concurrency, scaling
- **Idempotency [Built]:** Paystack `reference` UNIQUE + row lock; chat `(user_id, client_msg_id)` UNIQUE; one check-in per user/roadmap/day; one roadmap per user/track. **[Planned]:** `email_log` so reminders can't double-send.
- **Caching:** HTTP cache headers on static assets; in-process LRU cache of published course versions **[Built]**. No Redis yet.
- **Redis:** only needed when running ≥2 web instances (shared rate limits) or heavy queues. Until then, Postgres (jobs table / `pg-boss`) covers it for free. Upstash free tier (500K cmds/mo) is the fallback.
- **Load balancing:** Render fronts the service. One $7/$25 instance should handle a class because requests are I/O-bound on the AI call; **load-test before promising >100 concurrent students** **[Assumption]**. Scaling to 2 instances requires moving the in-memory rate limiter first.
- **Rate limiting:** per user when logged in, per IP otherwise (a whole class shares one IP). Auth limit is 60/15 min/IP (`AUTH_RATE_MAX`).

### 7.7 Security and privacy
- bcrypt (10 rounds), hashed verification/reset tokens, session fixation protection, CSRF on all state changes, security headers, `httpOnly` + `secure` + `sameSite=lax` cookies, new-device alert emails. **[Built]**
- Payments: HMAC-SHA512 webhook signature on the raw body; amounts checked against server-side price; tutor cannot see check-in notes; AI output rendered with `textContent` (no HTML injection). **[Built, tested]**
- Prompt-injection posture: student text is passed as data; the system prompt says so; the mentor has no tools or data access beyond the cohort syllabus.
- **To do before launch:** privacy policy and terms (mandatory: you hold learners' personal data); a lawful-basis and retention policy under Nigeria's data-protection law (NDPA 2023, **confirm with a lawyer**); handling for under-18 students (parental consent); data-deletion path; backups (confirm Neon point-in-time restore window on the plan you use); Paystack live-mode business verification (check current requirements).
- `.env` never in git; rotate any key that was ever shared.

---

## 8. Findings from the code assessment

| # | Finding | Severity | Fix | Phase |
|---|---|---|---|---|
| 1 | Roadmap generated per user in one ~40k-token synchronous call; no output cap/retry | **High (cost + reliability)** | Course Library (7.3) **built**; closes per track×level as plans are published, then remove the fallback | 2 |
| 2 | Reminder job emails *everyone with any roadmap and no check-in today*, sequentially, including completed or inactive users, inside one request; hits Brevo's 300/day cap past ~250 users; cron secret is a URL query param | High at scale | Limit to active users; batch/queue; per-day `email_log`; move secret to a header | 1.5 |
| 3 | Session store + last-active writes keep Neon awake, burning CU-hours | Medium | Accept, monitor; consider longer `touchLastActive` throttle | 1.5 |
| 4 | In-memory rate limiter | Medium | Fine for 1 instance; Postgres/Redis if scaling | 3 |
| 5 | No indexes beyond PKs/uniques/session (e.g., `roadmaps.user_id`, `assessments(user_id, track_id)`) | Medium as data grows | `roadmaps(user_id)` and `roadmaps(course_version_id)` **added** (`db/courses.sql`); `assessments(user_id, track_id)` still to do | 1.5 |
| 6 | Mentor default monthly cap 600 is loss-making on dearer models | High (economics) | Default → 300; model via env | **Done in this release** |
| 7 | `APP_URL` default still `voice2skill.onrender.com` | Low | Set `APP_URL=https://voice2skill.com` in Render | 1 |
| 8 | Brevo sender domain not authenticated; SPF record already exists for Namecheap forwarding, and a domain may have only one SPF record | Medium (spam folder) | Merge Brevo's include into the single SPF TXT; add DKIM | 1 |
| 9 | `scripts/migrateRoadmaps.js` regenerates content via AI (dangerous if run casually) | Low | Keep excluded from `npm run migrate`; document | 1 |
| 10 | Repo clutter: `preview-*.html`, planning docs in `docs/superpowers/` | Low | Move/delete | 2 |
| 11 | Assessment exists only for Software Engineering | Product gap | Add assessments for other tracks or skip level for them | 3 |
| 12 | No refund, cancel, or recurring-billing flow | Product gap | Manual refund in Paystack for pilot; Plans later | 3 |
| 13 | No analytics/observability | Medium | Sentry + a simple admin cost dashboard (AI spend, payments) | 2 |

**What is solid:** clean MVC separation, strong auth hygiene, CSRF and security headers, parameterized SQL, idempotent migrations, graceful AI fallback for the coach, an existing render-level smoke test, and now a 67-check end-to-end suite for the money and access paths.

---

## 9. Functional requirements and acceptance criteria

| ID | Requirement | Status | Acceptance |
|---|---|---|---|
| F1 | Signup, email verification, login, reset, change password, session management | Built | Existing flows pass smoke test |
| F2 | Goal capture (type/speak) → track match → assessment (SWE) → plan | Built | Plan appears; goal in plan intro |
| F3 | Daily check-in, one per day, streak, coach reply | Built | Duplicate check-in blocked; coach or fallback shown |
| F4 | Email reminders | Built (fix #2) | Only active, un-checked-in users emailed once/day |
| F5 | Organizations/cohorts/invite codes/syllabus | Built | Teacher creates cohort; code works case/dash-insensitively |
| F6 | Join, pay, renew (Paystack) | Built | Replayed/concurrent webhooks extend access once; underpayment rejected; expired access blocked |
| F7 | Mentor chat grounded in syllabus with caps | Built | 4th msg at cap=3 → 429; replay not double-billed |
| F8 | Teacher roster + earnings + nudge flag | Built | Teacher can't see notes; students can't open teacher pages |
| F9 | Ledger + payouts scripts | Built | Owed = share − payouts |
| F10 | Course Library (versioned, reusable, tutor-editable) | **Built** (library); tutor-editable cohort courses Planned P2 | New user on a published track×level gets a plan with 0 AI calls (e2e: `npm run test:cohorts`, "Course Library"); drafts never reach learners; invalid plans cannot be published; a new version does not change existing learners' plans |
| F11 | Premium individual tier (₦6,000/30 days; AI coach + mentor); Free has no AI | **Built** | `canUse` (`ai_coach`, `mentor_chat`); free check-in gets template coach; `POST /premium` → Paystack → access |
| F12 | React frontend + JSON API on Cloudflare Pages/Render | Planned P2 | All pages ported; cookies work cross-subdomain |
| F13 | Recurring billing, auto split payments | Planned P3 | Paystack plan renews; subaccount split matches ledger |
| F14 | Project submission + AI rubric feedback | Planned P3 | Capped per month; stored per user |
| F15 | Tutor announcements, "ask my tutor", weekly digest | Planned P3 | Delivered to cohort/tutor |
| F16 | Admin cost dashboard | Planned P2 | Shows AI spend/user, payments, margin |

---

## 10. Non-functional requirements
- **Availability:** no sleeping instance for paying users; target 99% monthly (single instance; honest about it).
- **Latency:** page loads <2 s on 3G for core pages; mentor reply p95 <15 s; AI timeout 25 s with a clear retry message.
- **Mobile-first:** most learners are on phones with limited data (small pages, no heavy JS).
- **Accessibility:** skip links and labels exist; keep WCAG AA contrast.
- **Cost:** AI spend ≤ 25% of net revenue per paying student (6.4 rule 6).
- **Money correctness:** integer kobo only; every settlement idempotent and auditable.
- **Testability:** `npm test` (render smoke) and `npm run test:cohorts` (e2e on a disposable Postgres) must pass before every deploy.

---

## 11. Roadmap

| Phase | When | Scope | Exit criteria |
|---|---|---|---|
| **1 — Pilot** | Now → ~2 weeks | Deploy cohort build; Render $7; Paystack test then live; create the tutor's org; load his syllabus; set `APP_URL`, `MENTOR_MODEL`, caps; Brevo domain auth; privacy policy/terms | Tutor's first cohort can join, pay, chat; tutor sees roster; ledger correct |
| **1.5 — Hardening** | Weeks 2–4 | Fix reminder job (#2), add indexes (#5), Sentry, load test, refund process, cost review | No incidents in a full week of daily use |
| **2 — Scale content & UX** | Month 2 | Course Library, React/API split + Cloudflare Pages, admin cost dashboard | Per-user AI cost ≈ chat only; site fast on mobile |
| **3 — Monetize deeper** | Month 3+ | Recurring billing, auto split, projects + AI feedback, tutor tools, org plan, 2nd bootcamp | 3+ bootcamps; positive monthly profit |

**Decision gate after Phase 1:** if the tutor's cohort does not reach ~70% of enrolled students active in week 2, fix retention (reminders, tutor nudges, content) before building Phase 2.

---

## 12. Success metrics
- **Activation:** % of joined students who check in within 48 h.
- **Retention:** week-2 and week-4 active check-in rate; average streak.
- **Conversion:** join → paid; free → Premium.
- **Engagement:** mentor msgs per paying student (watch the cap).
- **Economics:** AI cost ÷ net revenue; margin per student; MRR; churn; payback = ~0 CAC via tutors.
- **Tutor value:** % of "needs a nudge" students who check in within 3 days after the tutor acts.

---

## 13. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| One customer (the tutor) | Revenue concentration; he could leave | Written agreement; land 2nd bootcamp by Phase 3; individual tier as backstop |
| Students pay twice (tuition + mentor) | Low conversion | Ask the tutor about bundling (Option B); test price |
| AI price changes (Gemini 3.6 Flash is scheduled to double) | Margin collapse | Cheaper chat model, caps, model via env, multi-provider `ai` module |
| Free tiers disappear or aren't allowed commercially | Surprise bills / shutdown | Only free tiers permitted for commercial use; budget for paid; no hobby-only tools in production |
| Naira devaluation (costs in USD, revenue in NGN) | Margin erosion | Monthly FX check; price review quarterly; USD-linked pricing for Orgs later |
| AI says something wrong | Student harm / trust | Grounding, "check with your tutor" notice, tutor escalation (F15), no medical/legal scope |
| Data protection / minors | Legal exposure | Privacy policy, consent, deletion, lawyer review |
| Single-instance outage | Downtime during class | Paid instance, alerts, status message, runbook |
| Cheating/sharing codes | Revenue leakage | Per-account access, code can be closed/rotated, per-user caps |
| Tutor disputes on payouts | Trust | Transparent earnings panel, ledger script, written terms |

---

## 14. Open decisions (owner: founder)
1. Confirm Option A vs B with the tutor; confirm price per student and share % / basis.
2. Choose the mentor model after a quality test on the tutor's syllabus (Flash-Lite vs Haiku vs Flash).
3. Obtain the tutor's real syllabus (even rough notes). The mentor is only as good as this text.
4. Decide launch legal entity and Paystack account type; draft privacy policy and terms.
5. Premium price: **₦6,000 / 30 days (decided 14 Oct 2026)**; revisit after the first month of data.
6. Branding level for the organization plan.

---

## 15. Instructions for Claude Code (build rules)

1. **Read first:** this PRD, `docs/COHORTS.md`, `.env.example`.
2. **Never break free users, and never give them AI.** Anyone with no paid plan keeps the plan + check-in experience; AI features (coach, mentor, any new one) are gated through `canUse` to Premium/bootcamp.
3. **Money is integer kobo.** No floats for currency. Every paid-state change goes through `settlePayment`.
4. **Gate features only through `canUse(state, feature)`** in `utils/entitlements.js`. Add features there, not inline.
5. **Every migration idempotent** (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`); add new tables to `db/cohorts.sql` or a new `db/*.sql` run by a `scripts/migrate*.js` registered in `scripts/migrate.js`.
6. **Every AI feature needs:** per-user cap (via `ai_usage`), input/output size limits, a timeout, a fallback/error path, and an idempotency key if user-triggered.
7. **Prompt-injection hygiene:** user text is data; render AI output with `textContent` / EJS escaping only.
8. **Tests must pass before finishing:** `npm test` and `npm run test:cohorts` (against a **disposable** Postgres; set `DATABASE_URL`, `DATABASE_SSL=false`; never the production DB). Add tests for every new money/access path.
9. **No secrets in git.** New env vars go in `.env.example` and `docs/COHORTS.md`.
10. **Keep prices, caps and models configurable** (DB columns or env), not hard-coded.
11. **Do not use hobby-only or non-commercial free tiers** (Vercel Hobby, UptimeRobot free, Render free for production).
12. **Phase discipline:** build Phase 1/1.5 items first; do not start the React split until the exit criteria of Phase 1 are met.

---

## Appendix A — Environment variables
`DATABASE_URL`, `SESSION_SECRET`, `NODE_ENV`, `PORT`, `APP_URL`, `GEMINI_API_KEY`, `MENTOR_MODEL`, `MENTOR_DAILY_LIMIT` (40), `MENTOR_MONTHLY_LIMIT` (300), `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `PAYSTACK_SECRET_KEY`, `CRON_SECRET`, `AUTH_RATE_MAX` (60). Local/test only: `DATABASE_SSL=false`, `PG_POOL_MAX`, `PAYSTACK_MOCK=1`, `MENTOR_MOCK=1`, `EMAIL_MODE=log`.

## Appendix B — Commands
`npm run migrate` · `npm test` · `npm run test:cohorts` · `node scripts/createOrg.js "<Bootcamp>" <tutor-email> [pct] [net|gross]` · `node scripts/ledger.js [payout <orgId> <naira> "note"]`.

## Appendix C — Sources (checked 14 Oct 2026)
Render pricing (render.com/pricing) · Neon pricing (neon.com/pricing) · Paystack transaction charges (support.paystack.com) · Gemini API pricing and rate-limit pages (ai.google.dev) · Cloudflare Workers AI pricing (developers.cloudflare.com/workers-ai/platform/pricing) · Brevo pricing · Supabase pricing · Upstash Redis pricing · UptimeRobot pricing · hosting free-tier comparison (flaviocopes.com, checked 16 Sept 2026) · Paystack vs Flutterwave comparison (kolonell.com) · Claude Haiku 5.5 pricing (third-party report eesel.ai; confirm on Anthropic's official pricing page). Items not verifiable from these pages are marked [Assumption] or "not verified" above.
