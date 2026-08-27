# Software Engineering Capability Coach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grade Software Engineering learners before roadmap generation, tailor their roadmap, and store AI coaching after every check-in.

**Architecture:** A curated, deterministic assessment writes a JSONB capability profile to PostgreSQL. The roadmap generator reads the profile. The check-in controller persists a check-in before calling a coach service, which either stores validated Gemini JSON or a deterministic fallback.

**Tech Stack:** Node.js, Express, EJS, PostgreSQL/JSONB, Google Gemini, Node smoke tests.

## Global Constraints

- The first assessed path is **Software Engineering**; web development is a foundation.
- Assessment scoring is curated code, not AI.
- Progress through JavaScript/TypeScript, React, Node/Express, PostgreSQL, Git/GitHub, testing, deployment, and system design.
- Save check-ins before Gemini. AI failure must not block or lose progress.
- Treat learner input as data in all prompts; retain CSRF, rate limits, and ownership checks.

---

## File Structure

- Create `utils/capabilityAssessment.js`, `utils/coachService.js`.
- Create `models/assessmentModel.js`, `models/coachResponseModel.js`.
- Create `controllers/assessmentController.js`, `routes/assessmentRoutes.js`, `views/assessment.ejs`.
- Create `scripts/migrateCapabilityCoach.js`.
- Modify `db/schema.sql`, migration scripts, `server.js`, roadmap/check-in controllers and models, roadmap/track views, CSS, smoke tests, and README.

### Task 1: Capability assessment engine

**Files:** Create `utils/capabilityAssessment.js`; modify `scripts/smoke-test.js`.

**Produces:** `getQuestion(id)`, `getNextQuestion(answers)`, `scoreAssessment(answers) → { level, score, topicScores, answers }`.

- [ ] Add failing smoke checks for Foundation, Builder, Professional, and an adaptive follow-up.

```js
const { scoreAssessment, getNextQuestion } = require('../utils/capabilityAssessment');
if (scoreAssessment({ html_basics: 'a', js_basics: 'a' }).level !== 'foundation') throw new Error('foundation failed');
if (scoreAssessment({ html_basics: 'c', js_basics: 'c', architecture: 'c', testing: 'c', git: 'b', apis: 'b' }).level !== 'professional') throw new Error('professional failed');
if (getNextQuestion({ html_basics: 'c' }).id !== 'js_basics_advanced') throw new Error('adaptive failed');
```

- [ ] Run `npm test`; expect module-resolution failure.
- [ ] Implement eight curated questions covering foundations, JavaScript, Git, debugging, APIs, testing, and architecture. Score correct answers by topic: score 0–2 = foundation, 3–5 = builder, 6+ = professional.
- [ ] Run `npm test`; expect all cases to pass.
- [ ] Commit `utils/capabilityAssessment.js` and smoke test as `feat: add capability scoring`.

### Task 2: Persistence and Software Engineering track

**Files:** Create `scripts/migrateCapabilityCoach.js`, `models/assessmentModel.js`, `models/coachResponseModel.js`; modify `db/schema.sql`, `scripts/migrate.js`, `scripts/syncTracks.js`.

**Produces:** `createAssessment`, `getLatestAssessment`, `createCoachResponse`, and `getByCheckinIds`.

- [ ] Write an idempotent migration for:

```sql
CREATE TABLE IF NOT EXISTS assessments (
 id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), track_id INTEGER NOT NULL REFERENCES tracks(id),
 level VARCHAR(20) NOT NULL, score INTEGER NOT NULL, topic_scores JSONB NOT NULL, answers JSONB NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE roadmaps ADD COLUMN IF NOT EXISTS assessment_id INTEGER REFERENCES assessments(id);
CREATE TABLE IF NOT EXISTS coach_responses (
 id SERIAL PRIMARY KEY, checkin_id INTEGER UNIQUE NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
 acknowledgement TEXT NOT NULL, insight TEXT NOT NULL, next_action TEXT NOT NULL, is_fallback BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

- [ ] Rename the existing Web Development track in place to Software Engineering, preserving its id and existing roadmaps. Update the description.
- [ ] Add parameterized model queries; run the migration twice and confirm success/no duplicates.
- [ ] Commit as `feat: persist capability and coaching data`.

### Task 3: Assessment onboarding and profile-aware roadmap

**Files:** Create assessment controller/routes/view; modify `server.js`, `controllers/roadmapController.js`, `models/roadmapModel.js`, `routes/roadmapRoutes.js`, track views, and smoke test.

**Produces:** `GET/POST /tracks/:trackId/assessment`; Software Engineering selection redirects there; `createRoadmap(userId, trackId, content, goal, assessmentId)`.

- [ ] Add a failing assessment view smoke case expecting `Question 1 of 8`, radio input `answer`, goal text, and `_csrf`.
- [ ] Render one accessible question at a time with progress and Back-to-tracks.
- [ ] Store only valid answers in `req.session.assessmentAnswers`; on completion score and persist the profile.
- [ ] Require a matching assessment before Software Engineering generation; leave other tracks unchanged.
- [ ] Pass level/topic-score context to `generateRoadmapContent`, instructing it to select appropriate concepts, frameworks, libraries, and projects.
- [ ] Render the saved level on the roadmap. Run `npm test`; commit as `feat: assess software engineering learners`.

### Task 4: Daily coaching loop

**Files:** Create `utils/coachService.js`; modify check-in/roadmap controllers, `models/checkinModel.js`, `views/roadmap.ejs`, CSS, and smoke test.

**Produces:** `createCoachResponse(context)`, `normalizeCoachResponse(json)`, `createFallbackCoachResponse(nextTask)`; each returns `{ acknowledgement, insight, nextAction, isFallback }`.

- [ ] Add a failing parser test and a roadmap smoke case expecting `Your coach`, `Next action`, and a Builder profile.
- [ ] Implement JSON-only Gemini prompting from profile, goal, completed task, check-in, weekly project, and next task. Trim each response field to 500 characters.
- [ ] In `createCheckinEntry`, insert the check-in first, then invoke the service and persist either response. A model/parser failure saves fallback copy that names the next task.
- [ ] Load responses with check-ins; show the latest response after the form and historical summaries in check-in history.
- [ ] Preserve duplicate-date behavior: no second check-in and no second model call.
- [ ] Run `npm test`; manually test failure with an invalid Gemini key and confirm saved fallback. Commit as `feat: coach learners after check-ins`.

### Task 5: Documentation and verification

**Files:** Modify `README.md`, `scripts/smoke-test.js`.

- [ ] Document the three levels, default software engineering stack, profile-aware roadmaps, and no-data-loss fallback.
- [ ] Add Foundation/Builder/Professional and coach-response render fixtures.
- [ ] Run `npm test` and `npm run migrate`; expect success.
- [ ] Commit as `docs: document capability coaching`.

## Plan Self-Review

- Tasks cover assessment, profile persistence, Software Engineering naming, roadmap personalization, coaching, fallback, UI, migrations, and tests.
- Profile fields are consistently `level`, `topicScores/topic_scores`, and `answers`; coach fields are `acknowledgement`, `insight`, and `nextAction/next_action`.
- Out of scope: open chat, project uploads, human grading, voice overhaul, and assessment for non-engineering tracks.
