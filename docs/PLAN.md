# Voice2Skill — Rebuild Plan (brief Phases 1–7 mapped onto this codebase)

**Date:** 15 Oct 2026 · Builds on `docs/AUDIT.md`. **Nothing below is implemented yet; waiting for your go.**
Deadline: ~2 weeks. Must ship: Phases 1, 3, 4, 6. Phases 2 and 5 fill gaps.

---

## 0. Decisions I need from you (each has my recommendation)

**D1 — Which LLM providers may see student text?** *(blocks Phase 1 and 3)*
Today's privacy policy (`views/privacy.ejs`) and `CLAUDE.md` promise: student check-ins and mentor chats go **only to Gemini's paid tier**, which doesn't train on them. The brief's free-tier router breaks that promise. Stripping names doesn't fix it: check-in notes and chats are personal by nature. What each provider's terms say:

| Provider (free) | Trains on / reviews prompts? | Other limits |
|---|---|---|
| Groq | No retention by default; temporary abuse/troubleshooting logs up to 30 days, which can be switched off; Zero Data Retention available to all customers. The docs don't say whether they train. | Whisper limits listed: 20 req/min, 2,000/day, 7,200 audio-seconds/hour, 28,800/day; 25 MB per file; each request billed as at least 10 s. The page shows these as Developer-plan base limits, so **confirm the free numbers in your Groq console**. |
| Gemini unpaid | **Yes**: Google uses content to improve products, and humans may review it. Google says "do not submit … personal information". | Users must be **18+**; unpaid service may not be offered to EEA/UK users. |
| Mistral Experiment | Free plan **opts you into training by default**; you can switch it off in the Admin Console. | Phone verification. |
| OpenRouter `:free` | Depends on the provider; some train. A "no training" routing filter exists. | Rate limits are low. |

**Recommendation:**
- **Groq** (Zero Data Retention switched on) is the primary for every task that carries student text: mentor, check-in, speech-to-text.
- **Gemini paid tier** is the fallback. It is capped by the existing `ai_usage` limits and costs cents at pilot volume.
- **Mistral** is allowed only after you switch off training in its console.
- **OpenRouter** is used only for the **Course Library generation** (no personal data in those prompts), with its "no training" filter on.
- Update the privacy policy to name Groq. That needs your sign-off (CLAUDE.md legal rule).
- "Zero AI spend" then becomes "~₦0, with a hard cap", not literally zero.
- Alternative: go free-tier everywhere and rewrite the privacy policy to say chats may be used for training. I don't recommend it for a product that sells to bootcamps.

**D2 — Does the Free tier get any AI?** *(blocks Phase 1 caps and Phase 3)*
On 14 Oct you decided: Free = no AI; Premium (₦6,000) and bootcamps get the AI coach and mentor. The brief talks about "daily caps per tier (free and cohort)", which implies some AI for Free.
- **Recommendation:** keep Free with no AI coach or mentor. **But do give Free users voice transcription** (Groq Whisper, capped, e.g. 20 clips/day), because "Voice" is the product name and transcription is not coaching.
- Confirm or change.

**D3 — Phase 4 schema: keep what's built?**
The brief asks for `bootcamps`, `cohort_codes`, `enrollments`. The existing `organizations`, `cohorts` (with `invite_code`), `memberships` and `payments` already do this, and Paystack money flows are tested (replay, wrong amount, concurrency).
- **Recommendation:** keep the existing tables. Add the missing fields to `cohorts`: `max_seats`, `code_expires_at`. Revenue share stays per organization.
- No renames: a rename would mean rewriting a tested money path days before a cohort.

**D4 — Paystack (already built).** The brief says "propose Paystack, confirm before building". It is built and tested, in test mode. **Please confirm Paystack.**
- Related point (audit A19): access is currently granted from **either** the signed webhook **or** a server-to-server verify when the browser returns from checkout. The brief says webhook only. Webhook-only is stricter but means "payment done, access in a few seconds".
- **Recommendation:** keep both. The callback trusts Paystack's verify API, never the redirect itself, and this is Paystack's documented pattern. Or say "webhook only" and I'll change it.

**D5 — Roadmap personalisation (Phase 2).** The brief: "the LLM only personalises the cached skeleton". The Course Library built yesterday gives 0-AI plans with a template intro (ADR-001).
- **Recommendation:** keep 0-AI plans for everyone.
- Paid users get one capped, Groq-backed call that rewrites the intro plus each week's project around their goal and hours per week. It is a small output (~1–2k tokens), not a regenerated plan.
- Free users get the template.

**D6 — Email for missed-day nudges.** Brevo is already wired in (free 300/day).
- **Recommendation:** keep Brevo, fix the reminder query (A7), and authenticate the sending domain (SPF/DKIM).

**D7 — Retention mechanic (you asked for options, not a pick).** I'll build the `events` table so any of these can be added later:
1. **Weekly project showcase:** submit the week's project link. The tutor or cohort sees it; a streak bonus for submitting.
2. **Streak freeze plus milestones:** one "freeze" per week to protect a streak, plus badges at days 7/28/56. Cheap to build and proven in Duolingo-style apps.
3. **Cohort accountability board:** the tutor and cohort see who checked in this week (opt-in, counts only, never notes). Social pressure fits bootcamps.

**D8 — Gemini model id.** The brief says `gemini-2.5-flash`; the code uses `gemini-3.6-flash`. Model ids will live in config (Phase 1), so you can choose; I'll default to what your key supports.

---

## 1. Phase 1 — LLM router (days 1–3)

**Add** `services/llm.js`, built on the `openai` SDK with a per-provider `baseURL`. It exports:
- `complete({ task, system, messages, json?, schema?, maxTokens, userId? })`
- `stream({ ... })` for `mentor` and `checkin`

**Config:** `config/llm.js` holds providers, models and route order per task, with each value overridable by env (`LLM_ROUTE_MENTOR=groq,gemini,mistral`, `LLM_MODEL_GROQ=…`). Keys come from the env vars the brief names: `GROQ_KEY`, `GEMINI_KEY`, `MISTRAL_KEY`, `OPENROUTER_KEY`. `GEMINI_API_KEY` keeps working as an alias.

**Failover:**
- Moves to the next provider only on 429, 5xx, timeout (20 s, `LLM_TIMEOUT_MS`) or a network error.
- A 4xx such as 400 or 401 fails fast, so a bad prompt never burns three quotas.
- JSON tasks use `response_format` and are validated with a **zod** schema. A failed validation counts as a failure and moves to the next provider.

**Logging:** `db/llm.sql` adds `llm_calls` (provider, model, task, latency_ms, prompt_tokens, completion_tokens, ok, error_code, user_id, created_at), indexed on `(created_at)` and `(provider, created_at)`. **No prompt text is stored.** `node scripts/llmUsage.js` gives a daily per-provider summary; it later becomes an admin panel.

**Privacy guard inside the router:**
- No names, emails or phone numbers. Callers pass IDs only; the router also redacts email and phone patterns from user content as a backstop.
- Student text only goes in `user` messages, never in the system prompt.
- Every provider that is allowed to see student text is listed in config (D1).

**Rewire these call sites (one way to call AI):**
- `utils/mentorService.js` → `services/mentorService.js` (streaming)
- `utils/coachService.js` → `services/coachService.js`, which also gets a timeout and a JSON schema (fixes A5)
- `utils/courseGenerator.js` → `services/courseGenerator.js` (task `roadmap`)
- the fallback path in `roadmapController.generateRoadmapContent`

**Move:** the remaining business logic moves from `utils/` into `services/`, so the folder means one thing. `utils/` keeps pure helpers (format, streak, goalMatcher). Remove `@google/generative-ai` once nothing imports it.

**User-facing fallback:** keep the existing ones (template coach reply, mentor `502 ai_unavailable` with budget refunded). Add the "at capacity" page for the roadmap fallback.

**Streaming:** `POST /api/mentor/message` returns server-sent events. It keeps the same idempotency key (`clientMsgId`), cap reservation and refund logic. `mentor.ejs` renders the tokens as they arrive with `textContent`. The non-streaming JSON route stays as the fallback.

**Tests:** `scripts/llm-test.js` runs mock providers on a local HTTP server and checks:
- 429 → next provider
- 500 → next
- timeout → next
- 400 → no failover
- all fail → friendly error
- invalid JSON → next
- one `llm_calls` row per attempt
- no prompt text stored

## 2. Phase 3 — Voice end to end (days 3–6)

- **Endpoint:** `POST /api/voice/transcribe` (multipart).
  - Auth, CSRF header, and its own rate limiter (e.g. 10/min/user).
  - Daily cap in `ai_usage` (kind `stt`), per D2.
  - `multer` memory storage with a 4 MB limit (60 s of Opus webm is about 0.5 MB, so the cap is loose for codec variance).
  - Allowed MIME types: webm, ogg, mp4, m4a (`audio/mp4`, `audio/x-m4a`), checked by **magic bytes**, not the header.
  - Duration cap of 60 s, enforced client-side and re-checked server-side from the container metadata where possible. The byte cap is the hard limit.
- **Transcription:**
  - Primary: Groq `whisper-large-v3-turbo`.
  - Fallback: Gemini audio input, paid tier only (D1).
  - The audio buffer is **never written to disk or the DB**, only the transcript is returned; the buffer is dropped after the request.
- **Client:** `public/js/voice.js`, one reusable recorder component.
  - MediaRecorder with a mime type picked by `isTypeSupported` (`audio/webm;codecs=opus`, else `audio/mp4` for iOS Safari).
  - Shows a 60 s countdown, upload progress (XHR `upload.onprogress`, important on mobile data), and a retry.
  - Fallback order: MediaRecorder upload → Web Speech API → text box. If the mic permission is denied, it falls straight back to text with a short explanation.
- **Text-to-speech:** a `speechSynthesis` play/stop button on mentor replies and coach replies. The preference is remembered in `localStorage` (behind try/catch).
- **Where voice works:**
  - onboarding goal (`dashboard.ejs`)
  - daily check-in (`roadmap.ejs`)
  - mentor chat (`mentor.ejs`, new)
  - All three use `voice.js`, and the inline speech code in two views is deleted.
- **iOS Safari:** I'll test MediaRecorder mp4 in the in-app browser preview plus a real device check by you, since I can't drive a physical iPhone.
- **Tests:**
  - wrong MIME → 415
  - oversize → 413
  - no auth → 401
  - no CSRF → 403
  - over the cap → 429
  - happy path with a mock STT provider
  - provider fallback
  - nothing persisted
- **Privacy pages:** voice audio goes to Groq for transcription and is not stored. This needs your sign-off.

## 3. Phase 4 — Cohorts and monetisation (days 6–7; mostly built)

Already built: invite codes, server-side validation, memberships, Paystack checkout, signed idempotent webhook, revenue share (net or gross), payouts ledger, tutor dashboard, Premium.

To add:
- **Seats and expiry:** `cohorts.max_seats` (NULL = unlimited) and `cohorts.code_expires_at`. Joining checks both inside a transaction that counts active members under a row lock. Tests: a full cohort, an expired code, concurrent last-seat joins.
- **"Lock student to bootcamp":** record `users.signup_cohort_id` when the account is created through `/join?code=`, and attribute `payments.org_id` from the cohort (already done). Confirm whether a student may also join a second bootcamp; today they can.
- **Founder admin:**
  - `users.role = 'admin'` (column exists). `canUse(state, 'admin')`.
  - `/admin` shows bootcamps, cohorts, students, check-in streaks, active versus **at-risk** students (no check-in for ≥3 days while access is active; threshold in config), revenue collected, share owed and payouts.
  - The tutor's `/teacher` gets the same at-risk flag for their own cohorts.
  - All of it is read-only.
- **Webhook-only option** if you choose it in D4.

## 4. Phase 6 — Security (days 7–9; parallel with the above)

- `helmet`:
  - CSP with **per-request nonces**. The inline scripts in `dashboard`, `roadmap` and `mentor` move to `public/js/*.js`, so the CSP can be `script-src 'self'`.
  - HSTS.
  - It replaces `securityHeaders`; the hand-rolled middleware is deleted, not kept in parallel.
- `express-rate-limit` replaces the hand-rolled limiter behind the **same** `rateLimiter({windowMs,max})` signature, so routes don't change. It keeps the per-user key. Tighter tiers for auth, AI and upload.
- **CORS:** none today, because all requests are same-origin. Add a strict allow-list (`CORS_ORIGINS`) only on `/api/*`, ready for the React split.
- **zod:** `middleware/validate.js` plus one schema per route (body, params, query). The hand checks in controllers are removed as each route migrates. Starting order: auth, join/pay, mentor, voice, check-in.
- **Passwords:** bcrypt cost **12**, with transparent rehash on the next login for old cost-10 hashes.
- **Prompt-injection guard:** the system prompt defines scope; user text only in user turns. Known override phrases are neutralised (wrapped and labelled as quoted student text, not deleted). Model output never triggers actions: it is only rendered as text or stored.
- `GET /health`: `{ ok: true }` plus a DB ping only, with no config, versions or env.
- **Structured logs:** `utils/log.js` writes JSON lines (`level`, `msg`, `reqId`, `userId`), with a request id per request. It never logs bodies, tokens or card data.
- **Dependencies:** remove unused `nodemailer`, `node-cron` and `@anthropic-ai/sdk`, run `npm audit fix` (fixes the critical `proxy-addr` and moderate `qs`), and re-run until there are no high or critical findings.
- **Reminders (A7):** move the cron secret to a header, and email only active users (checked in within 7 days, roadmap not finished, not emailed today). Use a job queue (the existing `jobs` table) plus an `email_log` table for idempotency.
- **Tests:** auth (login, lockout limit, reset token single-use, rehash), CSP header present, `/health` leaks nothing.

## 5. Phase 2 and 5 gap-fill (days 9–10, as time allows)

- **Indexes (A16):** `assessments(user_id, track_id)`, `checkins(roadmap_id, checkin_date)`, `checkins(checkin_date)`, `mentor_messages(cohort_id)`.
- **Neon pooled connection:** use the `-pooler` host in `DATABASE_URL` on Render (an env change; documented in `COHORTS.md`).
- **Mentor memory:** `mentor_summaries(user_id, summary, upto_message_id)`. Send the summary plus the last 4–6 turns. A `jobs` task refreshes the summary every 10 messages through the router (task `summary`).
- **Onboarding:** add **hours per week** and **current level** (self-reported for tracks with no assessment). The library course is chosen by track × level. Hours per week feed the paid personalisation (D5) and the daily task copy.
- **Progress dashboard:** `/dashboard` shows current week, % complete, streak and next task. The data already exists on the roadmap page; I'll extract a `services/progress.js` used by both.
- **Events:** `events(user_id, kind, ref_id, data jsonb, created_at)`, written on check-in, roadmap created, payment settled and voice used. It is the hook for D7.
- **API routes:** each feature I touch gets a JSON route next to its EJS route (`/api/roadmaps/:id`, `/api/checkins`, `/api/progress`), calling the same service, for the later React split.

## 6. Phase 7 — Quality gates (every phase)

- **Tests:**
  - `npm test` (smoke)
  - `npm run test:cohorts` (e2e)
  - new `npm run test:llm` (router)
  - new voice and auth checks inside the e2e suite
  - All must pass before each phase is reported.
- **Migrations:** they stay idempotent and forward-only, in the existing pattern. "Reversible where possible": each new `db/<area>.sql` gets a matching `db/down/<area>.sql` for **additive** changes only. Nothing that drops user data runs without asking you.
- **Commits:** one per logical change, on a branch per phase, stacked on `feat/course-library`.
- **Docs:** update `README.md`, `.env.example`, `CLAUDE.md` and PRD statuses as I go.
- **End-of-phase report:** what changed, what's left, and the decisions needed.

## 7. Schedule (working days)

| Days | Work |
|---|---|
| 1–3 | Phase 1 router plus logging plus rewiring; dependency fixes (quick security win) |
| 3–6 | Phase 3 voice (endpoint, `voice.js`, three surfaces, TTS) |
| 6–7 | Phase 4 seats/expiry, admin view, at-risk |
| 7–9 | Phase 6 helmet/CSP (needs the inline-script move), zod, bcrypt 12, health, logs, reminders |
| 9–10 | Phase 2/5 gaps: indexes, mentor memory, hours/week, dashboard, events |

**Risks:**
- CSP refactor touches every view with inline script.
- iOS Safari recording needs a real-device check.
- The Groq free-tier numbers must be confirmed in your console.
- The unmerged branches (VOICE2-001, cohorts, Course Library) should be merged to `main` and deployed before new work lands, so we aren't building on top of an undeployed stack.
