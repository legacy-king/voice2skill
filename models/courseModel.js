/**
 * Course Library (ADR-001). A course is a track x level plan; a course version holds the plan JSON.
 * Generated versions start as 'draft'; publishing is a human step (scripts/courses.js publish).
 * Published/retired versions are immutable (DB trigger), so their content is cached in memory.
 */
const pool = require('../config/db');

const LEVELS = ['foundation', 'builder', 'professional'];
// Tracks without a capability assessment (everything except Software Engineering) start here.
const DEFAULT_LEVEL = 'foundation';

// ---- bounded in-memory cache of immutable version content (LRU by insertion order) ----
const CACHE_MAX = Math.max(1, Number(process.env.COURSE_CACHE_SIZE) || 50);
const versionCache = new Map();

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

function cacheGet(id) {
  const hit = versionCache.get(id);
  if (hit === undefined) return undefined;
  versionCache.delete(id); // refresh recency
  versionCache.set(id, hit);
  return hit;
}

function cacheSet(id, content) {
  versionCache.set(id, content);
  while (versionCache.size > CACHE_MAX) versionCache.delete(versionCache.keys().next().value);
}

/**
 * Content of a published (or retired) version, from cache or DB. Drafts are never served to
 * learners and never cached. Returned objects are frozen: readers must not mutate shared content.
 */
async function getVersionContent(versionId) {
  const cached = cacheGet(versionId);
  if (cached !== undefined) return cached;
  const { rows } = await pool.query(
    "SELECT content FROM course_versions WHERE id = $1 AND status IN ('published', 'retired')",
    [versionId]
  );
  if (!rows[0]) return null;
  const content = deepFreeze(rows[0].content);
  cacheSet(versionId, content);
  return content;
}

/** The published library version for track x level, or undefined. */
async function findPublishedLibraryVersion(trackId, level) {
  const { rows } = await pool.query(
    `SELECT v.id, v.version, c.id AS course_id, c.title, c.level
       FROM courses c
       JOIN course_versions v ON v.course_id = c.id AND v.status = 'published'
      WHERE c.track_id = $1 AND c.level = $2 AND c.cohort_id IS NULL`,
    [trackId, level]
  );
  return rows[0];
}

/** Library course for track x level, created if missing (idempotent under concurrency). */
async function ensureLibraryCourse(trackId, level, title) {
  await pool.query(
    `INSERT INTO courses (track_id, level, title) VALUES ($1, $2, $3)
     ON CONFLICT (track_id, level) WHERE cohort_id IS NULL DO NOTHING`,
    [trackId, level, title]
  );
  const { rows } = await pool.query(
    'SELECT * FROM courses WHERE track_id = $1 AND level = $2 AND cohort_id IS NULL',
    [trackId, level]
  );
  return rows[0];
}

async function getCourseWithTrack(courseId) {
  const { rows } = await pool.query(
    `SELECT c.*, t.name AS track_name, t.description AS track_description
       FROM courses c JOIN tracks t ON t.id = c.track_id
      WHERE c.id = $1`,
    [courseId]
  );
  return rows[0];
}

/** Saves a new draft as the next version number of the course. */
async function insertDraft(courseId, content, model) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialise version numbering per course.
    await client.query('SELECT id FROM courses WHERE id = $1 FOR UPDATE', [courseId]);
    const { rows } = await client.query(
      `INSERT INTO course_versions (course_id, version, status, content, model)
       VALUES ($1, (SELECT COALESCE(MAX(version), 0) + 1 FROM course_versions WHERE course_id = $1), 'draft', $2, $3)
       RETURNING id, version`,
      [courseId, JSON.stringify(content), model]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Publishes a draft: the course's current published version becomes 'retired' (roadmaps pinned
 * to it keep working), and this one becomes the version new roadmaps get.
 * `validate(content)` is re-run here so nothing malformed can ever be published.
 */
async function publishVersion(versionId, validate) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM course_versions WHERE id = $1 FOR UPDATE', [versionId]);
    const v = rows[0];
    if (!v) throw new Error(`course version ${versionId} not found`);
    if (v.status !== 'draft') throw new Error(`course version ${versionId} is ${v.status}, only drafts can be published`);
    if (validate) validate(v.content);
    await client.query('SELECT id FROM courses WHERE id = $1 FOR UPDATE', [v.course_id]);
    await client.query(
      "UPDATE course_versions SET status = 'retired' WHERE course_id = $1 AND status = 'published'",
      [v.course_id]
    );
    await client.query(
      "UPDATE course_versions SET status = 'published', published_at = NOW() WHERE id = $1",
      [versionId]
    );
    await client.query('COMMIT');
    return { ...v, status: 'published' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listCourses() {
  const { rows } = await pool.query(
    `SELECT c.id AS course_id, c.level, c.title, c.cohort_id, t.name AS track_name,
            v.id AS version_id, v.version, v.status, v.model, v.created_at, v.published_at,
            (SELECT COUNT(*)::int FROM roadmaps r WHERE r.course_version_id = v.id) AS roadmaps
       FROM courses c
       JOIN tracks t ON t.id = c.track_id
       LEFT JOIN course_versions v ON v.course_id = c.id
      ORDER BY t.name, array_position(ARRAY['foundation','builder','professional']::varchar[], c.level), v.version`
  );
  return rows;
}

module.exports = {
  LEVELS,
  DEFAULT_LEVEL,
  getVersionContent,
  findPublishedLibraryVersion,
  ensureLibraryCourse,
  getCourseWithTrack,
  insertDraft,
  publishVersion,
  listCourses,
  _versionCache: versionCache
};
