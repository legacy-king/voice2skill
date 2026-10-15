# ADR-001: Course Library — generate plans once per track × level, reference them from roadmaps

**Status:** Proposed
**Date:** 2026-10-14
**Deciders:** Kingsley Ivom (founder)
**Relates to:** PRD §4.1, §6.4 rule 1, §7.3, finding #1 (§8), F10 (§9)

## Context

Today every new roadmap is one synchronous Gemini call inside the user's HTTP request
(`generateRoadmapContent` in `controllers/roadmapController.js`):

- The prompt asks for the full 8-week plan as one JSON document: 56 days with a 300–450 word
  lesson each, plus code, quizzes, resources and 8 weekly projects. That is roughly 40k output tokens
  (PRD estimate, ~₦150–₦450 per user at list prices).
- There is no `maxOutputTokens`, no timeout, no retry and no schema enforcement. The model is
  hard-coded (`gemini-3.6-flash`), and the request blocks until the model finishes. A truncated or
  invalid JSON reply surfaces as the "we're at capacity" page.
- The cost scales with **signups**, not with revenue. Free users, who pay nothing, trigger the
  single most expensive AI call in the product.

**What already exists (not reflected in the PRD).** Commit `81a4942` on
`feat/VOICE2-001-…` adds a reuse cache: `roadmaps.is_cached` plus `findCachedRoadmap(track, goal,
level)`, which copies another user's content when the trimmed, lower-cased goal text matches
**exactly**. It helps for identical goals ("learn python"), but free-text goals rarely collide, the
lookup scans `roadmaps` with no index, and each hit stores another full copy of the JSON.

**Who reads plan content.** `roadmap.content.weeks` is read in exactly four places, all via
`roadmapModel` rows: the roadmap page (`roadmapController.getRoadmap`), the check-in flow
(`checkinController`), the mentor's "current task" grounding (`mentorController.currentTaskLine`),
and `scripts/migrateRoadmaps.js`. Check-ins reference `roadmap_id`. Any design that keeps
`roadmap.content` populated on read leaves every caller unchanged.

**Forces**
- PRD rule: shared content is generated once, never per user (§6.4.1).
- PRD rule: prompts containing user or tutor text must use the **paid** Gemini tier (§6.3).
  Library prompts contain no personal data, but **cohort courses are built from the tutor's
  syllabus**, which is the tutor's content and must not go to the free tier either.
- Neon storage is billed per GB, and a full plan JSON is large (estimate ~150–250 KB). Copying it
  into every user's row grows storage with users rather than with content.
- One Render instance, one developer, a ~2-week pilot. No new infrastructure if avoidable.
- Free users must keep the same experience (PRD §15.2).

## Decision

Build a **versioned Course Library in Postgres** and have roadmaps **reference** a published
version instead of holding their own copy:

1. New tables (idempotent, in `db/courses.sql` + `scripts/migrateCourses.js`):
   - `courses (id, track_id, level, cohort_id NULL, title)`, unique on `(track_id, level)` where
     `cohort_id IS NULL`, and on `cohort_id` for cohort courses.
   - `course_versions (id, course_id, version, status draft|published|retired, content JSONB,
     model, created_at, published_at)`, with one `published` row per course enforced by a partial
     unique index.
   - `jobs (id, kind, payload JSONB, status, attempts, run_after, last_error, …)`, used by the
     generator (and later by reminders, PRD finding #2).
2. `roadmaps` gains `course_version_id INTEGER NULL REFERENCES course_versions(id)`. New
   library-backed roadmaps store `content = NULL` and point at a version. Existing rows keep their
   own `content` and are never rewritten.
3. **One read path.** `roadmapModel` resolves `content` from the version when the row's own
   content is NULL, so the four readers above are untouched. Published versions are immutable, so
   they are cached in process memory by id (safe on any number of instances).
4. **Generation is a background job, never in a request.** One Gemini call **per week** (8 calls
   per plan), each with `responseMimeType: 'application/json'` plus a response schema,
   `maxOutputTokens`, a timeout and retry. A failed week retries alone instead of the whole plan.
   The job runs inside the existing web process, polling `jobs` with `FOR UPDATE SKIP LOCKED`. No
   separate worker service.
5. **Publishing is a human step.** Generated versions land as `draft`; the founder reviews and
   publishes (script now, admin page later). Tutors edit their cohort course's draft and publish
   it.
6. **Personalisation is a thin layer.** The user's goal and assessment level choose the course
   (`track × level`). The goal-aware intro is rendered from a template, so creating a roadmap makes
   0 AI calls. An optional AI intro can come later as a capped, paid-tier call.
7. **Model and tier per feature.** The library model is an env var (`COURSE_MODEL`). Cohort-course
   generation goes through `ai_usage` with a per-org cap (kind `course_gen`) on the paid tier.
8. **Fallback during rollout.** If no published version exists for a `track × level`, the current
   per-user path (with the exact-goal cache) still runs. Once all 15 library courses are
   published, the per-user path is removed.

## Options Considered

### Option A: Keep per-user generation, harden it

Split the call per week, add caps, timeout, retry and JSON schema, and keep the exact-goal cache.

| Dimension | Assessment |
|---|---|
| Complexity | Low: changes one function |
| Cost | Still ~₦150–₦450 per **signup**, including free users; unbounded as the funnel grows |
| Scalability | Poor: AI spend and latency grow with signups; 30–90 s waits in the request |
| Team familiarity | High: same code |

**Pros:** smallest change; per-user content can reflect the exact goal.
**Cons:** breaks PRD rule 6.4.1; the free funnel is the most expensive thing to serve; quality is
unreviewed and different for every user; still blocks a request on a long AI call.

### Option B: Course Library, copy the published JSON into each roadmap (snapshot)

Same library and jobs as the decision, but `roadmaps.content` is filled with a copy at assignment.

| Dimension | Assessment |
|---|---|
| Complexity | Lowest of the library options: no read-path change at all |
| Cost | ~₦0 AI per user; storage grows ~150–250 KB **per user** (estimate) |
| Scalability | AI cost solved; storage scales with users, e.g. ~10k users ≈ 2 GB of duplicated JSON |
| Team familiarity | High |

**Pros:** each roadmap is frozen, so a later version can never change a student's plan mid-course;
the simplest code.
**Cons:** duplicate storage billed on Neon; course fixes (typos, broken links) never reach existing
users; the existing `is_cached` copies already show this pattern.

### Option C: Course Library, roadmaps reference a version (**chosen**)

| Dimension | Assessment |
|---|---|
| Complexity | Medium: 3 tables, 1 column, 1 resolver in `roadmapModel`, a job runner |
| Cost | ~₦0 AI per user; one-time generation of 15 plans (≈600k output tokens ≈ $2–5 on the paid tier, or $0 on free); storage per user ≈ one integer |
| Scalability | AI cost flat in users; content cached in memory per immutable version |
| Team familiarity | Medium: the job runner and versioning are new, but plain Postgres and Express |

**Pros:** meets PRD rule 6.4.1; instant roadmap creation; reviewed and consistent quality; fixes
ship as a new version; the same mechanism serves cohort courses (F10, tutor-editable).
**Cons:** more moving parts than B; needs a rule for what happens to a student when a new
version publishes (see Consequences); in-memory cache must be bounded.

### Option D: Static course files in the repo (JSON committed to git)

| Dimension | Assessment |
|---|---|
| Complexity | Low for the 15 library plans |
| Cost | ~₦0 |
| Scalability | Fine for library plans; **does not work for tutor-edited cohort courses** |
| Team familiarity | High |

**Pros:** content reviewed in PRs; no DB tables.
**Cons:** every content fix is a deploy; cohort courses would still need a DB design, so this
becomes two systems.

## Trade-off Analysis

- **A vs the library options.** A keeps cost tied to signups, which the free tier makes
  unbounded, and it cannot meet the PRD's own non-negotiable rule. Its only advantage, per-goal
  content, is weak: the existing cache already shows goals rarely match exactly, and a template
  intro gives most of the personal feel for free.
- **B vs C (copy vs reference).** B is simpler and freezes each plan. C saves storage and lets
  fixes propagate. The decisive factor is cohort courses: tutors will edit syllabi during a cohort,
  and students expect to see this week's version. C gets that for free; B needs a re-copy job. C
  can still freeze a student when needed by pinning `course_version_id` (the default; see below).
- **D vs C.** D is attractive for the 15 static plans, but it would be a second system next to the
  DB-backed cohort courses. One mechanism is worth the extra table.
- **Free vs paid tier for library generation.** The free tier is allowed (no personal data), but
  its rate limits are unpublished and the whole one-time job costs a few dollars on the paid tier.
  Recommendation: paid tier, for predictability. Cohort courses must use the paid tier regardless,
  because the syllabus is the tutor's content.

## Consequences

**Easier**
- New users get a plan instantly with 0 AI calls (F10 acceptance).
- AI spend per user becomes chat + coach only, which the PRD's unit economics (§5.4) already
  assume.
- Fixing a lesson is a new version, not a support ticket.
- Cohort courses (tutor syllabus → plan) reuse the same tables and job runner.
- The `jobs` table gives the reminder job (finding #2) a queue without Redis.

**Harder**
- **Version upgrade rule.** Default: a roadmap stays pinned to the version it started on; new
  roadmaps get the latest. Cohort courses: pinned to the cohort's current published version, so a
  tutor's publish reaches the whole class. Changing a published version's day count mid-course
  must be blocked (check-in day numbers index into `weeks[].days[]`).
- The read path now has a join or cache lookup. Bound the in-memory cache (LRU, ~50 versions).
- A content review step is now a real workflow for the founder.
- The job runner shares the web process; a long job must not starve requests (one job at a time,
  each AI call already has a timeout).

**Revisit**
- Remove the exact-goal cache (`is_cached`, `findCachedRoadmap`) and the per-user generation path
  once all 15 library courses are published. Keep old rows' `content` as is.
- Whether an optional AI-written intro is worth its cost (measure activation with the template
  first).
- Move the job runner to a separate Render worker only if jobs ever affect request latency.

## Action Items

1. [ ] Merge prerequisites first: the cohort branch, the VOICE2-001 roadmap-cache branch, and the
       PRD bundle's doc/config changes (keep the 4 review fixes; the bundle does not contain them).
2. [x] `db/courses.sql` + `scripts/migrateCourses.js` (courses, course_versions, jobs,
       `roadmaps.course_version_id`); register in `scripts/migrate.js`.
3. [x] `roadmapModel`: resolve `content` from `course_version_id` when the row's content is NULL;
       bounded in-memory cache of published versions. Tests: all four readers render a
       library-backed roadmap unchanged.
4. [x] `services/courseGenerator.js`: per-week generation with JSON schema, `maxOutputTokens`,
       timeout, retry; `COURSE_MODEL` env var; validate 8 weeks × 7 days before saving a draft.
5. [x] In-process job runner (`FOR UPDATE SKIP LOCKED`, one job at a time, attempts + backoff).
6. [~] `scripts/courses.js generate|list|show|publish` for the founder **(built)**; generate and
       review the 15 `track × level` drafts **(founder, not done)**.
7. [x] `selectTrack`: if a published course exists for `track × level`, create the roadmap
       pointing at it (0 AI calls) with a templated goal intro; otherwise the current path.
8. [x] Indexes: `roadmaps(user_id)`, `roadmaps(course_version_id)` (PRD finding #5).
9. [ ] Cohort courses (F10, phase 2 proper): generate from syllabus via a job, capped per org in
       `ai_usage`, paid tier, editable draft → publish on the teacher page.
10. [ ] After all 15 are published: remove the per-user generation path and the exact-goal cache;
        update PRD §4.1 and §7.3 to **[Built]**.
