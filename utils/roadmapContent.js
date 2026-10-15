/**
 * Roadmap content is AI output — treat it as untrusted data.
 *
 * normalizeRoadmapContent() keeps only the fields the app uses, as strings of
 * bounded length. It is used:
 *  - strictly before saving a NEW roadmap (invalid → throw, nothing stored or cached)
 *  - leniently when displaying an EXISTING roadmap, so one odd field in an old
 *    row can't take the whole page down.
 */

const MAX_WEEKS = 12;
const MAX_DAYS_PER_WEEK = 7;

/** AI-generated links must be plain http(s) — never `javascript:` or similar. */
function sanitizeResourceUrl(url) {
  if (typeof url !== 'string') return '#';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : '#';
  } catch {
    return '#';
  }
}

function str(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Lenient mode keeps a placeholder instead of dropping a day: progress is the
// check-in count, so removing a day would shift every later day by one.
const PLACEHOLDER_TASK = 'Review what you have covered so far this week.';

function normalizeDay(day, index, strict) {
  if (!day || typeof day !== 'object') day = {};
  const task = str(day.task, 500) || (strict ? '' : PLACEHOLDER_TASK);
  if (!task) return null;

  const quiz = Array.isArray(day.quiz)
    ? day.quiz
      .map(q => ({ question: str(q && q.question, 500), answer: str(q && q.answer, 1000) }))
      .filter(q => q.question && q.answer)
      .slice(0, 5)
    : [];

  const normalized = {
    day_number: Number.isInteger(day.day_number) ? day.day_number : index + 1,
    day_type: day.day_type === 'weekend' ? 'weekend' : 'weekday',
    task,
    lesson: str(day.lesson, 6000),
    quiz,
    resource_name: str(day.resource_name, 100),
    resource_url: sanitizeResourceUrl(day.resource_url),
    video_search_term: str(day.video_search_term, 150)
  };
  const codeExample = str(day.code_example, 4000);
  if (codeExample) normalized.code_example = codeExample;
  return normalized;
}

function normalizeWeek(week, index, strict) {
  if (!week || typeof week !== 'object' || !Array.isArray(week.days)) return null;
  const days = week.days.slice(0, MAX_DAYS_PER_WEEK).map((d, i) => normalizeDay(d, i, strict)).filter(Boolean);
  if (days.length === 0) return null;
  return {
    week_number: Number.isInteger(week.week_number) ? week.week_number : index + 1,
    focus: str(week.focus, 200),
    project: str(week.project, 1000),
    days
  };
}

/**
 * @param {unknown} content parsed model output or a stored roadmaps.content value
 * @param {object} [opts]
 * @param {boolean} [opts.strict=true] throw unless every week is complete
 * @returns {{weeks: Array}} normalized content
 */
function normalizeRoadmapContent(content, { strict = true } = {}) {
  const rawWeeks = content && typeof content === 'object' && Array.isArray(content.weeks)
    ? content.weeks.slice(0, MAX_WEEKS)
    : [];
  const weeks = rawWeeks.map((w, i) => normalizeWeek(w, i, strict)).filter(Boolean);

  if (strict) {
    if (weeks.length === 0 || weeks.length !== rawWeeks.length) {
      throw new Error('Roadmap output failed validation: missing or malformed weeks');
    }
    const incomplete = weeks.some(w => w.days.length < MAX_DAYS_PER_WEEK || w.days.some(d => !d.lesson));
    if (incomplete) {
      throw new Error('Roadmap output failed validation: a week is missing days or lessons');
    }
  }
  return { weeks };
}

/** Flatten weeks into one ordered list of days, each tagged with its week. */
function flattenRoadmapDays(content) {
  return content.weeks.flatMap(week =>
    week.days.map(day => ({ ...day, week_focus: week.focus, week_number: week.week_number, week_project: week.project }))
  );
}

module.exports = { normalizeRoadmapContent, flattenRoadmapDays, sanitizeResourceUrl };
