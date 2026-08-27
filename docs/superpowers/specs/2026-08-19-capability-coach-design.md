# Capability Assessment and Daily AI Coach

## Goal

Make Voice2Skill useful as a professional-engineering learning product, not only a roadmap tracker. A learner's level must shape both their initial roadmap and the coaching they receive after every check-in.

## Scope

This release introduces Software Engineering as the first deep capability pathway. Web development becomes one foundation within that pathway, not the final outcome. The existing non-engineering tracks remain unchanged. It adds a capability assessment before roadmap creation and a persisted AI coaching response after a daily check-in.

## Learner journey

1. A learner chooses Software Engineering.
2. Before a roadmap exists, they take an eight-question adaptive diagnostic.
3. The diagnostic places them in one of three levels:
   - **Foundation:** programming and web fundamentals, Git, debugging, and small projects.
   - **Builder:** JavaScript/TypeScript, React, APIs, Node/Express, PostgreSQL, testing, and deployable applications.
   - **Professional:** architecture, system design, performance, security, testing strategy, observability, code review, and production engineering.
4. The generated eight-week roadmap uses the level and the detailed strengths/gaps.
5. The learner completes a daily task and submits a check-in.
6. The check-in is stored before any AI call. The learner is then shown a saved response with an observation, an improvement point, encouragement, and the next concrete task.

## Assessment

Questions are curated and versioned in code rather than AI-generated. This keeps grading predictable and auditable. The question bank covers programming and semantic web foundations, JavaScript, Git, debugging, APIs/data, testing, architecture, and trade-offs.

The assessment is adaptive by selecting harder follow-up questions after correct answers. Topic scores identify strengths and gaps. The score determines the overall level:

- Foundation: needs core fundamentals before frameworks.
- Builder: can build projects but needs professional workflow and application engineering depth.
- Professional: can work with production concepts and should be challenged with architecture and trade-offs.

## Curriculum direction

Roadmaps use JavaScript/TypeScript, React, Node.js/Express, PostgreSQL, Git/GitHub, testing, deployment, and system design as the practical default stack. A level never skips essential engineering habits: clear requirements, version control, debugging, testing, security, documentation, monitoring, and deployable work.

Frameworks and libraries are introduced only when a level's prerequisite knowledge supports them. Every week includes a tangible outcome rather than passive reading alone.

## Data model

Add an `assessments` record for each completed diagnostic, including the user, track, score, level, topic scores, and answers. A roadmap references the assessment used to generate it.

Add a one-to-one `coach_responses` record for each check-in, storing the response text and structured fields needed by the UI. The existing `checkins` table remains the source of completion history.

## Coaching flow

The controller validates and saves the check-in first. A coach service then asks Gemini for compact, structured JSON using only the learner's capability profile, stated goal, current task, weekly project, check-in text, and next roadmap task. User-supplied text is treated as data, never instructions.

If generation fails, the app stores a deterministic fallback response that confirms the check-in and directs the learner to the next existing roadmap task. A failed AI request must never erase a check-in or block the user.

## UI

Add an assessment page between track selection and roadmap generation. It shows one question at a time, progress, and no misleading claim of precision.

On the roadmap page, show the latest coach response directly after submission and label the learner's current level. Check-in history includes the saved response in a compact, readable form.

## Testing

Add automated checks for adaptive question selection, score-to-level mapping, capability-profile persistence, valid coach-response parsing, Gemini failure fallback, and the check-in route's ownership and duplicate protections.

## Non-goals

This release does not introduce an open-ended AI chat interface, file/project uploads, human grading, a voice transcription overhaul, or capability assessment for the other non-engineering tracks.
