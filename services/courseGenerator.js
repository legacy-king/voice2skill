/**
 * Course Library generator (ADR-001). Builds ONE shared 8-week plan for a track x level in a
 * background job (never inside a user's request). Per week: one call for the outline (focus,
 * project, the 7 day topics in order), then one call per day for the detailed lesson, 3-5 quiz
 * questions and 2-3 free resources. A day this detailed doesn't fit 7-to-a-call.
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
const { log } = require('../utils/log');

const WEEKS = 8;
const DAYS_PER_WEEK = 7;
const RETRIES = () => Math.max(1, Number(process.env.COURSE_RETRIES) || 3);
const MAX_TEXT = { focus: 200, project: 1500, task: 600, lesson: 12000, code_example: 4000, question: 600, answer: 1500, resource_name: 120, resource_url: 300, video_search_term: 200 };
// The prompt asks for 900-1,400 words (weekend 500-800); below these floors the day is regenerated.
const MIN_LESSON_WORDS = { weekday: 700, weekend: 350 };
const QUIZ = { min: 3, max: 5 };
const RESOURCES = { min: 2, max: 3 };

const LEVEL_HINTS = {
  foundation: 'Level "foundation": start with absolute basics, more scaffolding, simpler projects.',
  builder: 'Level "builder": assume working knowledge, focus on intermediate concepts and real-world projects.',
  professional: 'Level "professional": skip basics, focus on advanced topics, architecture and complex projects.'
};

const NON_CODE_TRACKS = ['UI/UX Design', 'Digital Marketing'];

const str = { type: 'string' };
const OUTLINE_SCHEMA = {
  type: 'object',
  properties: {
    week_number: { type: 'integer' },
    focus: str,
    project: str,
    days: { type: 'array', minItems: DAYS_PER_WEEK, maxItems: DAYS_PER_WEEK, items: { type: 'object', properties: { task: str }, required: ['task'] } }
  },
  required: ['week_number', 'focus', 'project', 'days']
};
const DAY_SCHEMA = {
  type: 'object',
  properties: {
    lesson: str,
    code_example: str,
    quiz: { type: 'array', minItems: QUIZ.min, maxItems: QUIZ.max, items: { type: 'object', properties: { question: str, answer: str }, required: ['question', 'answer'] } },
    resources: { type: 'array', minItems: RESOURCES.min, maxItems: RESOURCES.max, items: { type: 'object', properties: { name: str, url: str }, required: ['name', 'url'] } },
    video_search_term: str
  },
  required: ['lesson', 'quiz', 'resources', 'video_search_term']
};

const SHARED = 'The plan is shared by every learner on this track and level, so do not address any individual.';

/** Week outline: the focus, the project, and 7 day topics in the order they should be learned. */
function weekPrompt({ trackName, trackDescription, level, weekNumber, previousWeeks }) {
  const sofar = previousWeeks.length
    ? `Weeks already written (build on them, do not repeat them):\n${previousWeeks.map((w) => `- Week ${w.week_number}: ${w.focus}`).join('\n')}`
    : 'This is the first week of the plan.';
  const finale = weekNumber === WEEKS ? '\nThis is the final week: consolidate everything and make the project a portfolio-ready capstone.' : '';
  return `You are an expert instructor planning week ${weekNumber} of ${WEEKS} of a shared learning plan for "${trackName}" (${trackDescription}).
${LEVEL_HINTS[level]}
${sofar}${finale}

Outline week ${weekNumber} as JSON matching the response schema:
- "week_number": ${weekNumber}. "focus": a short title for the week. "project": one specific, concrete practice project that applies the week's learning.
- "days": exactly ${DAYS_PER_WEEK} days in the order they should be learned, each building on the one before. "task": a short, direct instruction naming that day's topic.
  Days 1-5 each teach one new topic. Days 6-7 are the weekend: review the week and build the project.
${SHARED}`;
}

/** One day in full: a detailed lesson, 3-5 quiz questions, 2-3 free resources. */
function dayPrompt({ trackName, trackDescription, level, weekNumber, focus, project, tasks, dayIndex }) {
  const technical = !NON_CODE_TRACKS.includes(trackName);
  const weekday = dayIndex < 5;
  const list = tasks.map((t, i) => `${i + 1}. ${t}${i === dayIndex ? '   <- today' : ''}`).join('\n');
  const lesson = weekday
    ? `a detailed lesson of 900-1,400 words that fully teaches today's topic, the way a serious instructor would. Sections, in order: why it matters (where it is used in real work); the core idea in plain language, with key terms defined; how it works, step by step, including the underlying mechanics; a worked example walked through line by line; common mistakes and how to avoid them; a short practice exercise to do now (no answer given); a recap of the key points and how today connects to the day before and the day after.`
    : `a 500-800 word review and practice session: the week's key ideas and how they fit together, a guided practice task that moves the week project forward, and a self-check list.`;
  return `You are an expert instructor writing ONE day of a shared ${WEEKS}-week learning plan for "${trackName}" (${trackDescription}).
${LEVEL_HINTS[level]}
Week ${weekNumber} of ${WEEKS}: "${focus}". This week's project: ${project}
The week's days, in order:
${list}
Today is day ${dayIndex + 1}: "${tasks[dayIndex]}". Teach today's topic only: assume the earlier days, leave later days for later.

Write today as JSON matching the response schema:
- "lesson": ${lesson} Plain text, no markdown. Separate paragraphs with a blank line and start each section with a short heading line.
- ${technical ? '"code_example": a complete, runnable example that the lesson\'s worked example refers to, with brief comments.' : 'Omit "code_example" unless the day genuinely involves code (for example CSS).'}
- "quiz": 3-5 questions that test understanding, not memory: mix recall, "what happens if...", and one applied or debugging question. Each "answer" explains why in 1-3 sentences.
- "resources": 2-3 free resources for reading further on today's exact topic, from well-known, real, free sites (official documentation, MDN Web Docs, freeCodeCamp, W3Schools and similar), different sites where possible. "name": the site and the page, for example "MDN: Closures". "url": the https URL of the specific page that covers today's topic.
- "video_search_term": a YouTube search phrase (not a link).
${SHARED}`;
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

function cleanQuiz(quiz, where) {
  if (!Array.isArray(quiz) || !quiz.length) throw new Error(`${where}: missing quiz`);
  return quiz.slice(0, QUIZ.max).map((q, k) => ({
    question: cleanText(q && q.question, MAX_TEXT.question, `${where} quiz ${k + 1} question`),
    answer: cleanText(q && q.answer, MAX_TEXT.answer, `${where} quiz ${k + 1} answer`)
  }));
}

function cleanResources(list, where) {
  if (!Array.isArray(list) || !list.length) throw new Error(`${where}: missing resources`);
  return list.slice(0, RESOURCES.max).map((r, k) => {
    if (!isHttpUrl(r && r.url)) throw new Error(`${where} resource ${k + 1}: not an http(s) URL`);
    return { name: cleanText(r.name, MAX_TEXT.resource_name, `${where} resource ${k + 1} name`), url: cleanText(r.url, MAX_TEXT.resource_url, `${where} resource ${k + 1} url`) };
  });
}

function validateOutline(raw, weekNumber) {
  const where = `week ${weekNumber} outline`;
  if (!raw || !Array.isArray(raw.days) || raw.days.length !== DAYS_PER_WEEK) throw new Error(`${where}: expected ${DAYS_PER_WEEK} days`);
  return {
    focus: cleanText(raw.focus, MAX_TEXT.focus, `${where} focus`),
    project: cleanText(raw.project, MAX_TEXT.project, `${where} project`),
    tasks: raw.days.map((d, i) => cleanText(d && d.task, MAX_TEXT.task, `${where} day ${i + 1} task`))
  };
}

/** One day's detail. Generation-time only: a thin lesson, under 3 questions or under 2 resources is regenerated. */
function validateDayDetail(raw, { weekday }) {
  if (!raw || typeof raw !== 'object') throw new Error('day: not an object');
  const lesson = cleanText(raw.lesson, MAX_TEXT.lesson, 'lesson');
  const words = lesson.split(/\s+/).length;
  const min = MIN_LESSON_WORDS[weekday ? 'weekday' : 'weekend'];
  if (words < min) throw new Error(`lesson is ${words} words, needs at least ${min}`);
  const quiz = cleanQuiz(raw.quiz, 'day');
  if (quiz.length < QUIZ.min) throw new Error(`${quiz.length} quiz questions, needs ${QUIZ.min}`);
  const resources = cleanResources(raw.resources, 'day');
  if (resources.length < RESOURCES.min) throw new Error(`${resources.length} resources, needs ${RESOURCES.min}`);
  const day = { lesson, quiz, resources, video_search_term: cleanText(raw.video_search_term, MAX_TEXT.video_search_term, 'video_search_term') };
  if (typeof raw.code_example === 'string' && raw.code_example.trim()) day.code_example = raw.code_example.trim().slice(0, MAX_TEXT.code_example);
  return day;
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
    if (!isHttpUrl(d.resource_url)) throw new Error(`${where}: resource_url is not an http(s) URL`);
    const day = {
      day_number: (weekNumber - 1) * DAYS_PER_WEEK + i + 1,
      day_type: i < 5 ? 'weekday' : 'weekend',
      task: cleanText(d.task, MAX_TEXT.task, `${where} task`),
      lesson: cleanText(d.lesson, MAX_TEXT.lesson, `${where} lesson`),
      quiz: cleanQuiz(d.quiz, where),
      resource_name: cleanText(d.resource_name, MAX_TEXT.resource_name, `${where} resource_name`),
      resource_url: cleanText(d.resource_url, MAX_TEXT.resource_url, `${where} resource_url`),
      video_search_term: cleanText(d.video_search_term, MAX_TEXT.video_search_term, `${where} video_search_term`)
    };
    if (d.resources !== undefined) day.resources = cleanResources(d.resources, where);
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
      quiz: [1, 2, 3].map((k) => ({ question: `Question ${k}?`, answer: 'Today\'s concept.' })),
      resources: [{ name: 'freeCodeCamp', url: 'https://www.freecodecamp.org' }, { name: 'MDN Web Docs', url: 'https://developer.mozilla.org' }],
      resource_name: 'freeCodeCamp',
      resource_url: 'https://www.freecodecamp.org',
      video_search_term: `${trackName} week ${weekNumber}`
    }))
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LINK_TIMEOUT_MS = 5000;

/** Does this link answer? Only public https hostnames are fetched (no IPs, no localhost), redirects are not followed. */
async function linkWorks(u, fetchImpl) {
  if (u.protocol !== 'https:' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return false;
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetchImpl(u.href, { method, redirect: 'manual', signal: AbortSignal.timeout(LINK_TIMEOUT_MS) });
      if (res.body) res.body.cancel().catch(() => {});
      if (res.status < 400) return true;
      if (res.status !== 403 && res.status !== 405) return false; // only a refused HEAD gets a GET
    } catch {
      return false;
    }
  }
  return false;
}

/** AI-written deep links can be wrong: a link that doesn't answer becomes its site's home page. */
async function checkLinks(week, fetchImpl = fetch) {
  const checked = async (url) => {
    const u = new URL(url);
    const home = `${u.protocol}//${u.host}/`;
    return url === home || (await linkWorks(u, fetchImpl)) ? url : home;
  };
  for (const day of week.days) {
    if (!day.resources) { day.resource_url = await checked(day.resource_url); continue; }
    for (const r of day.resources) r.url = await checked(r.url);
    day.resources = day.resources.filter((r, i, all) => all.findIndex((o) => o.url === r.url) === i);
    day.resource_url = day.resources[0].url;
  }
  return week;
}

const SYSTEM = 'You are an expert instructor who writes rigorous, practical learning plans. Reply with JSON only, matching the response schema.';

/** One AI call, retried with backoff on timeout / bad JSON / failed validation. */
async function withRetries(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES(); attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      log.error(`Course ${label} attempt ${attempt} failed: ${err.message}`);
      if (attempt < RETRIES()) await sleep(2000 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`${label} failed after ${RETRIES()} attempts: ${lastErr.message}`);
}

/** One week: the outline, then each day in detail. onProgress() runs after every day (job heartbeat). */
async function generateWeek({ onProgress = async () => {}, ...args }) {
  const n = args.weekNumber;
  if (process.env.COURSE_MOCK === '1') return { week: validateWeek(mockWeek(args), n), models: ['mock'] };
  const models = new Set();
  const ask = (label, content, jsonSchema, validate) => withRetries(label, async () => {
    const { data, provider, model } = await llm.complete({ task: 'course', system: SYSTEM, messages: [{ role: 'user', content }], jsonSchema, validate });
    models.add(`${provider}:${model}`);
    return data;
  });
  const outline = await ask(`week ${n} outline`, weekPrompt(args), OUTLINE_SCHEMA, (raw) => validateOutline(raw, n));
  const days = [];
  for (let i = 0; i < DAYS_PER_WEEK; i++) {
    const weekday = i < 5;
    const prompt = dayPrompt({ ...args, focus: outline.focus, project: outline.project, tasks: outline.tasks, dayIndex: i });
    const d = await ask(`week ${n} day ${i + 1}`, prompt, DAY_SCHEMA, (raw) => validateDayDetail(raw, { weekday }));
    days.push({ ...d, day_type: weekday ? 'weekday' : 'weekend', task: outline.tasks[i], resource_name: d.resources[0].name, resource_url: d.resources[0].url });
    await onProgress();
  }
  const week = validateWeek({ focus: outline.focus, project: outline.project, days }, n);
  return { week: await checkLinks(week), models: [...models] };
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
      // Re-saving the finished weeks after each day keeps the job's heartbeat fresh.
      const onProgress = () => onWeek(weeks.slice(), [...models]);
      const made = await generateWeek({ trackName, trackDescription, level, weekNumber: n, previousWeeks: weeks, onProgress });
      week = made.week;
      made.models.forEach((m) => models.add(m));
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

module.exports = { generateCourse, generateWeek, validateWeek, validateDayDetail, validateCourse, checkLinks, runCourseJob, weekPrompt, dayPrompt, OUTLINE_SCHEMA, DAY_SCHEMA, WEEKS, DAYS_PER_WEEK };
