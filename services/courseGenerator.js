/**
 * Course Library generator (ADR-001). Builds ONE shared 8-week plan for a track x level, one
 * Gemini call per week, in a background job (never inside a user's request).
 *
 * Each call goes through the LLM router (services/llm.js, task 'course'): JSON response schema,
 * output cap, timeout and provider failover come from config/llm.js. On top of that a failed week
 * is retried with backoff (COURSE_RETRIES). A failed week retries alone; finished weeks are saved as job progress, so a retried job resumes instead
 * of paying for the whole plan again. The result is validated (8 weeks x 7 days) and saved as a
 * DRAFT; a human publishes it with `node scripts/courses.js publish <versionId>`.
 *
 * Prompts contain only the track name/description and level: no user or tutor text.
 * Env: COURSE_RETRIES; models/route/timeout via LLM_* (config/llm.js).
 * COURSE_MOCK=1 returns canned weeks (tests / local dev without a key).
 */
const courseModel = require('../models/courseModel');
const llm = require('./llm');

const WEEKS = 8;
const DAYS_PER_WEEK = 7;
const RETRIES = () => Math.max(1, Number(process.env.COURSE_RETRIES) || 3);
const MAX_TEXT = { focus: 200, project: 1500, task: 600, lesson: 6000, code_example: 4000, question: 600, answer: 1500, resource_name: 120, resource_url: 300, video_search_term: 200 };

const LEVEL_HINTS = {
  foundation: 'Level "foundation": start with absolute basics, more scaffolding, simpler projects.',
  builder: 'Level "builder": assume working knowledge, focus on intermediate concepts and real-world projects.',
  professional: 'Level "professional": skip basics, focus on advanced topics, architecture and complex projects.'
};

const NON_CODE_TRACKS = ['UI/UX Design', 'Digital Marketing'];

const str = { type: 'string' };
const WEEK_SCHEMA = {
  type: 'object',
  properties: {
    week_number: { type: 'integer' },
    focus: str,
    project: str,
    days: {
      type: 'array',
      minItems: DAYS_PER_WEEK,
      maxItems: DAYS_PER_WEEK,
      items: {
        type: 'object',
        properties: {
          day_number: { type: 'integer' },
          day_type: { type: 'string', enum: ['weekday', 'weekend'] },
          task: str,
          lesson: str,
          code_example: str,
          quiz: {
            type: 'array',
            minItems: 1,
            items: { type: 'object', properties: { question: str, answer: str }, required: ['question', 'answer'] }
          },
          resource_name: str,
          resource_url: str,
          video_search_term: str
        },
        required: ['day_number', 'day_type', 'task', 'lesson', 'quiz', 'resource_name', 'resource_url', 'video_search_term']
      }
    }
  },
  required: ['week_number', 'focus', 'project', 'days']
};

function weekPrompt({ trackName, trackDescription, level, weekNumber, previousWeeks }) {
  const technical = !NON_CODE_TRACKS.includes(trackName);
  const sofar = previousWeeks.length
    ? `Weeks already written (build on them, do not repeat them):\n${previousWeeks.map((w) => `- Week ${w.week_number}: ${w.focus}`).join('\n')}`
    : 'This is the first week of the plan.';
  const finale = weekNumber === WEEKS ? '\nThis is the final week: consolidate everything and make the project a portfolio-ready capstone.' : '';
  return `You are an expert instructor writing week ${weekNumber} of ${WEEKS} of a shared learning plan for "${trackName}" (${trackDescription}).
${LEVEL_HINTS[level]}
${sofar}${finale}

Write week ${weekNumber} as JSON matching the response schema:
- "week_number": ${weekNumber}. "focus": a short title for the week. "project": one specific, concrete practice project that applies the week's learning.
- "days": exactly ${DAYS_PER_WEEK} days, "day_number" 1 to ${DAYS_PER_WEEK}. Days 1-5 are "weekday", days 6-7 are "weekend".
- "task": a short, direct instruction naming the day's focus.
- "lesson": weekdays a genuine 300-450 word explanation that TEACHES the concept in real depth: the underlying mechanics, why it works this way, common beginner mistakes, and how it connects to earlier days. Weekends a shorter review/practice lesson. Write like a senior practitioner mentoring someone seriously.
- ${technical ? '"code_example": a short, real, runnable snippet demonstrating the concept.' : 'Omit "code_example" unless the day genuinely involves code (for example CSS).'}
- "quiz": exactly 1 short comprehension question with its answer explained briefly.
- "resource_name"/"resource_url": a well-known, real, free platform (freeCodeCamp, MDN Web Docs, official docs, W3Schools), root https URL only.
- "video_search_term": a YouTube search phrase (not a link).
The plan is shared by every learner on this track and level, so do not address any individual.`;
}

function cleanText(value, max, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`missing ${field}`);
  return value.trim().slice(0, max);
}

function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Validates and normalises one week. day_number becomes the plan-wide day (1..56). Throws on bad data. */
function validateWeek(week, weekNumber) {
  if (!week || typeof week !== 'object') throw new Error(`week ${weekNumber}: not an object`);
  if (!Array.isArray(week.days) || week.days.length !== DAYS_PER_WEEK) {
    throw new Error(`week ${weekNumber}: expected ${DAYS_PER_WEEK} days, got ${Array.isArray(week.days) ? week.days.length : 'none'}`);
  }
  const days = week.days.map((d, i) => {
    const where = `week ${weekNumber} day ${i + 1}`;
    if (!d || typeof d !== 'object') throw new Error(`${where}: not an object`);
    if (!Array.isArray(d.quiz) || !d.quiz.length) throw new Error(`${where}: missing quiz`);
    if (!isHttpUrl(d.resource_url)) throw new Error(`${where}: resource_url is not an http(s) URL`);
    const day = {
      day_number: (weekNumber - 1) * DAYS_PER_WEEK + i + 1,
      day_type: i < 5 ? 'weekday' : 'weekend',
      task: cleanText(d.task, MAX_TEXT.task, `${where} task`),
      lesson: cleanText(d.lesson, MAX_TEXT.lesson, `${where} lesson`),
      quiz: d.quiz.slice(0, 3).map((q, k) => ({
        question: cleanText(q && q.question, MAX_TEXT.question, `${where} quiz ${k + 1} question`),
        answer: cleanText(q && q.answer, MAX_TEXT.answer, `${where} quiz ${k + 1} answer`)
      })),
      resource_name: cleanText(d.resource_name, MAX_TEXT.resource_name, `${where} resource_name`),
      resource_url: cleanText(d.resource_url, MAX_TEXT.resource_url, `${where} resource_url`),
      video_search_term: cleanText(d.video_search_term, MAX_TEXT.video_search_term, `${where} video_search_term`)
    };
    if (typeof d.code_example === 'string' && d.code_example.trim()) {
      day.code_example = d.code_example.trim().slice(0, MAX_TEXT.code_example);
    }
    return day;
  });
  return {
    week_number: weekNumber,
    focus: cleanText(week.focus, MAX_TEXT.focus, `week ${weekNumber} focus`),
    project: cleanText(week.project, MAX_TEXT.project, `week ${weekNumber} project`),
    days
  };
}

/** A whole plan must be exactly 8 weeks x 7 days: check-in day numbers index into it. */
function validateCourse(content) {
  if (!content || !Array.isArray(content.weeks) || content.weeks.length !== WEEKS) {
    throw new Error(`course must have exactly ${WEEKS} weeks`);
  }
  content.weeks.forEach((w, i) => {
    validateWeek(w, i + 1);
    if (w.week_number !== i + 1) throw new Error(`week ${i + 1}: week_number is ${w.week_number}`);
    w.days.forEach((d, k) => {
      const expected = i * DAYS_PER_WEEK + k + 1;
      if (d.day_number !== expected) throw new Error(`week ${i + 1} day ${k + 1}: day_number is ${d.day_number}, expected ${expected}`);
    });
  });
  return content;
}

function mockWeek({ trackName, level, weekNumber }) {
  return {
    week_number: weekNumber,
    focus: `${trackName} ${level} week ${weekNumber}`,
    project: `Build a small ${trackName} project for week ${weekNumber}.`,
    days: Array.from({ length: DAYS_PER_WEEK }, (_, i) => ({
      day_number: i + 1,
      day_type: i < 5 ? 'weekday' : 'weekend',
      task: `Library task W${weekNumber}D${i + 1}`,
      lesson: `Library lesson for week ${weekNumber}, day ${i + 1}.`,
      quiz: [{ question: 'What did you learn?', answer: 'Today\'s concept.' }],
      resource_name: 'freeCodeCamp',
      resource_url: 'https://www.freecodecamp.org',
      video_search_term: `${trackName} week ${weekNumber}`
    }))
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYSTEM = 'You are an expert instructor who writes rigorous, practical learning plans. Reply with JSON only, matching the response schema.';

/** One week, retried with backoff on timeout / bad JSON / failed validation. */
async function generateWeek(args) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES(); attempt++) {
    try {
      if (process.env.COURSE_MOCK === '1') return { week: validateWeek(mockWeek(args), args.weekNumber), model: 'mock' };
      const { data, provider, model } = await llm.complete({
        task: 'course',
        system: SYSTEM,
        messages: [{ role: 'user', content: weekPrompt(args) }],
        jsonSchema: WEEK_SCHEMA,
        validate: (raw) => validateWeek(raw, args.weekNumber)
      });
      return { week: data, model: `${provider}:${model}` };
    } catch (err) {
      lastErr = err;
      console.error(`Course week ${args.weekNumber} attempt ${attempt} failed: ${err.message}`);
      if (attempt < RETRIES()) await sleep(process.env.COURSE_MOCK === '1' ? 0 : 2000 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`week ${args.weekNumber} failed after ${RETRIES()} attempts: ${lastErr.message}`);
}

/**
 * Generates the full plan, week by week. `done` holds weeks finished by an earlier attempt;
 * `onWeek(weeks, models)` is called after each new week so the caller can persist progress.
 * Resolves with { content, models } (models = the provider:model pairs that wrote the weeks).
 */
async function generateCourse({ trackName, trackDescription, level, done = [], doneModels = [], onWeek = async () => {} }) {
  if (!LEVEL_HINTS[level]) throw new Error(`unknown level "${level}"`);
  if (process.env.NODE_ENV === 'production' && process.env.COURSE_MOCK === '1') {
    throw new Error('COURSE_MOCK must not be set in production');
  }
  const weeks = [];
  const models = new Set(doneModels);
  for (let n = 1; n <= WEEKS; n++) {
    const saved = done[n - 1];
    let week = null;
    if (saved) {
      try { week = validateWeek(saved, n); } catch { week = null; }
    }
    if (!week) {
      const made = await generateWeek({ trackName, trackDescription, level, weekNumber: n, previousWeeks: weeks });
      week = made.week;
      models.add(made.model);
      weeks.push(week);
      await onWeek(weeks.slice(), [...models]);
    } else {
      weeks.push(week);
    }
  }
  return { content: validateCourse({ weeks }), models: [...models] };
}

/**
 * Job handler for kind 'course_gen' (payload { courseId }). Saves the plan as a draft version.
 * Returns the job result; progress is kept in the job's result between attempts.
 */
async function runCourseJob(job, { saveProgress }) {
  const course = await courseModel.getCourseWithTrack(job.payload.courseId);
  if (!course) throw new Error(`course ${job.payload.courseId} not found`);
  const done = (job.result && Array.isArray(job.result.weeks)) ? job.result.weeks : [];
  const doneModels = (job.result && Array.isArray(job.result.models)) ? job.result.models : [];
  const { content, models } = await generateCourse({
    trackName: course.track_name,
    trackDescription: course.track_description || '',
    level: course.level,
    done,
    doneModels,
    onWeek: (weeks, usedModels) => saveProgress({ weeks, models: usedModels })
  });
  const draft = await courseModel.insertDraft(course.id, content, models.join(',').slice(0, 80));
  return { courseId: course.id, versionId: draft.id, version: draft.version };
}

module.exports = { generateCourse, generateWeek, validateWeek, validateCourse, runCourseJob, weekPrompt, WEEK_SCHEMA, WEEKS, DAYS_PER_WEEK };
