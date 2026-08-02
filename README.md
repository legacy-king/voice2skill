# Voice2Skill 🚀

**From Learning to Earning.**

Voice2Skill is an AI-powered career and digital skills coach that helps people go from "I don't know where to start" to a structured, accountable path toward a real digital career.

## The Problem

Many people want to learn digital skills — web development, UI/UX design, data analysis, digital marketing — but don't know what to learn, where to start, or how to stay consistent. Free resources exist everywhere, but structure and accountability don't.

## What It Does

- 🎯 Choose a skill track (Web Development, UI/UX Design, Data Analysis, Digital Marketing, Cybersecurity)
- 🎙️ Tell us your goal in your own words (type or speak) — we match it to the closest track and show next-best alternatives
- 🗺️ Get an AI-generated, personalized 8-week roadmap with real, free resources — your goal is persisted on the roadmap and woven into the plan
- 📺 Every daily task links to a YouTube search tuned with your goal phrasing
- 📚 Follow a structured weekly and daily focus, not a random collection of tutorials
- ✅ Log daily check-ins to track consistency and progress

## Tech Stack

- **Backend:** Node.js, Express
- **Database:** PostgreSQL (hosted on Neon)
- **Sessions:** express-session + connect-pg-simple (Postgres-backed)
- **Templating:** EJS
- **AI:** Google Gemini API (roadmap generation)
- **Auth:** bcrypt + email verification + hashed tokens

## Project Structure

```
voice2skill/
├── config/        # Database connection (pg Pool)
├── controllers/   # Route logic (auth, tracks, roadmaps, checkins, reminders)
├── models/        # Database queries
├── routes/        # Express route definitions
├── middleware/    # CSRF, rate limiting, security headers
├── utils/         # goal matcher, mailer, streak
├── views/         # EJS templates (+ preview-*.html static previews)
├── db/            # Schema definition
├── scripts/       # Migrations, smoke/SIT tests, track sync
└── server.js      # App entry point
```

---

## Authentication Flows

### Signup + Email Verification ✉️
1. User signs up with name, email, password (min 8 chars). Validation happens server-side.
2. An account is created **unverified** with a random 32-byte token (stored as its SHA-256 hash) that expires in **24h**.
3. A verification email is sent with a confirmation link. The user is **not** auto-logged-in.
4. Clicking `/verify-email/confirm?token=...` marks the account verified and logs the user in (with a fresh session).
5. Logging in before verifying redirects to `/login?error=not_verified`.
6. `/verify-email` lets users request a new link (rate-limited, no email-existence leak).
7. Re-signing up with an unverified email re-sends the link instead of erroring with "already registered".

### Password Reset 🔑
1. `/forgot-password` takes an email; if it exists, a hashed token with a **30-minute** expiry is stored and a reset link is emailed (rate-limited; same redirect whether or not the email exists).
2. `/reset-password?token=...` validates the token and shows the new-password form.
3. Submitting updates the password hash, records `password_changed_at`, **revokes every other session** for that user, and redirects to login with a success banner.

### Password Change → Session Revocation
- `userModel.deleteUserSessions(userId, exceptSid)` removes all `session` rows belonging to the user.
- Called after a password reset (no `exceptSid` — every session dies, including the reset flow's own) so a compromised device's session can't survive the change.

### Change Password (logged in) 🔐
1. `/change-password` (auth required) shows a current-password + new-password form.
2. Submitting verifies the **current password** with bcrypt before accepting the change (rate-limited against brute force).
3. On success the hash is updated, `password_changed_at` is recorded, and **every other session is revoked** — `deleteUserSessions(userId, req.sessionID)` keeps only the device that made the change signed in.
4. The page is linked from the app nav (next to Log out).

### Security Page — Session Management 🖥️
1. Every session stamps device metadata at login/verify: user-agent, IP, and sign-in time (stored in the session row itself).
2. **Last-active tracking** — a throttled `touchLastActive` middleware updates `session.lastActiveAt` for logged-in users at most once per 5 minutes, so the security page shows when each device was last used without writing to the DB on every request. The current device shows "Active now".
3. `GET /security` lists all of the user's active sessions (`userModel.listUserSessions`) with a readable device label (e.g. "Chrome · Windows"), the last-active/sign-in/expiry dates, and a **"This device"** badge on the current session.
4. `POST /security/revoke` deletes **one** session by `sid` — but only if it belongs to the logged-in user (`deleteUserSession` checks ownership in the same query) and **never** the current session (`sid === req.sessionID` is rejected with `error=self`).
5. Revoking a device signs it out on its next request — the deleted session row simply no longer exists, so `req.session.userId` is gone.

---

## Migrations

Migrations are idempotent — safe to run repeatedly against an existing database.

| Script | Adds |
|--------|------|
| `node scripts/migrateGoals.js` | `roadmaps.goal` column |
| `node scripts/migrateVerification.js` | `users.email_verified`, `verification_token`, `verification_token_expires` (grandfathers existing accounts as verified) |
| `node scripts/migratePasswordReset.js` | `users.password_reset_token`, `users.password_reset_token_expires` |
| `node scripts/migrateSessions.js` | `session` table (connect-pg-simple) + `users.password_changed_at` |
| `node scripts/syncTracks.js` | Syncs the 5 landing-page tracks (renames legacy "Software Development" → "Web Development") |

**`npm run migrate`** runs all five migrations in order against the configured database (each is idempotent, so it's safe to run repeatedly). `db/schema.sql` is the canonical schema for fresh installs.

---

## Security Model

- **CSRF** — session token + hidden `_csrf` field on every POST form; state-changing routes are POST-only (roadmap creation and logout are not GET links).
- **Rate limiting** — in-memory per-IP limiter on auth, goal-matching, roadmap creation, and check-in routes.
- **Session hardening** — httpOnly, `SameSite=Lax`, `Secure` in production, 7-day expiry, `trust proxy` for `req.ip`, and the server **refuses to start in production without `SESSION_SECRET`**.
- **Ownership checks** — roadmaps and check-ins are verified to belong to the logged-in user (404 rather than leaking other users' data).
- **Token handling** — verification/reset tokens are stored as SHA-256 hashes; comparisons are against hashes; CRON secret uses `crypto.timingSafeEqual`.
- **Output safety** — EJS auto-escapes user data; AI-generated `resource_url` is sanitized to `http(s):` only before being rendered into links; email HTML escapes user names.
- **Input validation** — name/email/password on signup, goal length caps, note length caps.

### Required environment variables
```
DATABASE_URL        # Postgres connection string (Neon)
SESSION_SECRET      # REQUIRED in production (server refuses to start without it)
GEMINI_API_KEY      # Roadmap generation
GMAIL_USER          # Sender for reminder/verification/reset emails
GMAIL_APP_PASSWORD  # Gmail app password
CRON_SECRET         # Guards GET /api/send-reminders
APP_URL             # Public base URL used in email links (defaults to onrender URL)
```

`EMAIL_MODE=log` prints emails instead of sending — used by automated tests.

---

## Tests

- **UAT / template smoke test:** `npm test` (or `node scripts/smoke-test.js`) — renders every view with representative data and asserts content; also unit-checks the goal matcher and search-phrase logic. No database required.
- **SIT (system integration):** `EMAIL_MODE=log node scripts/sit-test.js` — boots the real server against the configured database and walks the full auth journey: signup → verify → login → forgot password → reset → session revocation. Requires `DATABASE_URL` in `.env`.

## Status

🚧 Early beta — actively being built and tested with early users. Feedback welcome.

## Author

Built by [KAAY_DEV](https://github.com/legacy-king/voice2skill) — CS student at NOUN, freelance developer, and founder exploring digital skills accessibility in Nigeria.
