#!/usr/bin/env node
/**
 * Course Library admin (ADR-001). Generated plans land as drafts; nothing reaches learners until
 * you review and publish one.
 *
 *   node scripts/courses.js list
 *   node scripts/courses.js generate <track name|id> <foundation|builder|professional> [--queue-only]
 *   node scripts/courses.js generate --all [--queue-only]     (every track x level with no published version)
 *   node scripts/courses.js show <versionId> [week]           (print a version, or one week, for review)
 *   node scripts/courses.js publish <versionId>
 *
 * `generate` queues a background job and, unless --queue-only, runs the queue in this process until
 * the job finishes (the web process's runner may pick it up instead; SKIP LOCKED keeps that safe).
 * Costs AI: 8 LLM router calls per plan (task "course", see config/llm.js).
 */
const pool = require('../config/db');
const courseModel = require('../models/courseModel');
const jobRunner = require('../services/jobRunner');
const { validateCourse } = require('../services/courseGenerator');

const usage = () => {
  console.error('Usage: node scripts/courses.js list | generate <track> <level> [--queue-only] | generate --all [--queue-only] | show <versionId> [week] | publish <versionId>');
  process.exit(2);
};

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

async function findTrack(ref) {
  const { rows } = /^\d+$/.test(ref)
    ? await pool.query('SELECT * FROM tracks WHERE id = $1', [Number(ref)])
    : await pool.query('SELECT * FROM tracks WHERE LOWER(name) = LOWER($1)', [ref]);
  if (!rows[0]) throw new Error(`track "${ref}" not found`);
  return rows[0];
}

async function queueCourse(track, level) {
  if (!courseModel.LEVELS.includes(level)) throw new Error(`level must be one of ${courseModel.LEVELS.join(', ')}`);
  const course = await courseModel.ensureLibraryCourse(track.id, level, `${track.name} — ${cap(level)}`);
  const { job, created } = await jobRunner.enqueue('course_gen', { courseId: course.id }, { dedupeKey: `course_gen:${course.id}` });
  console.log(`${created ? 'Queued' : 'Already queued'} job ${job.id}: ${course.title} (course ${course.id})`);
  return job.id;
}

async function waitFor(jobIds) {
  const pending = new Set(jobIds);
  while (pending.size) {
    const ran = await jobRunner.runOnce();
    const { rows } = await pool.query('SELECT id, status, attempts, result, last_error, run_after FROM jobs WHERE id = ANY($1)', [[...pending]]);
    for (const j of rows) {
      if (j.status === 'done') {
        console.log(`✓ job ${j.id} done: draft version ${j.result.versionId} (v${j.result.version}). Review with: node scripts/courses.js show ${j.result.versionId}`);
        pending.delete(j.id);
      } else if (j.status === 'failed') {
        console.log(`✗ job ${j.id} failed after ${j.attempts} attempts: ${j.last_error}`);
        pending.delete(j.id);
      }
    }
    if (pending.size && !ran) await new Promise((r) => setTimeout(r, 2000));
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const queueOnly = args.includes('--queue-only');
  const pos = args.filter((a) => !a.startsWith('--'));

  if (cmd === 'list') {
    const rows = await courseModel.listCourses();
    if (!rows.length) console.log('No courses yet. Start with: node scripts/courses.js generate --all');
    for (const r of rows) {
      const v = r.version_id
        ? `v${r.version} [${r.status}] id=${r.version_id} model=${r.model || '-'} roadmaps=${r.roadmaps}${r.published_at ? ` published ${new Date(r.published_at).toISOString().slice(0, 10)}` : ''}`
        : '(no versions)';
      console.log(`${r.track_name} / ${r.level} (course ${r.course_id}): ${v}`);
    }
    const { rows: jobs } = await pool.query(
      "SELECT id, status, attempts, payload, last_error FROM jobs WHERE kind = 'course_gen' AND status IN ('queued','running','failed') ORDER BY id DESC LIMIT 20"
    );
    for (const j of jobs) console.log(`job ${j.id} course ${j.payload.courseId}: ${j.status} (attempts ${j.attempts})${j.last_error ? ` — ${j.last_error}` : ''}`);
  } else if (cmd === 'generate') {
    let ids = [];
    if (args.includes('--all')) {
      const { rows: tracks } = await pool.query('SELECT * FROM tracks ORDER BY id');
      for (const track of tracks) {
        for (const level of courseModel.LEVELS) {
          if (!(await courseModel.findPublishedLibraryVersion(track.id, level))) ids.push(await queueCourse(track, level));
        }
      }
    } else {
      if (pos.length !== 2) usage();
      ids = [await queueCourse(await findTrack(pos[0]), pos[1])];
    }
    if (!queueOnly && ids.length) await waitFor(ids);
  } else if (cmd === 'show') {
    if (!/^\d+$/.test(pos[0] || '')) usage();
    const { rows } = await pool.query('SELECT * FROM course_versions WHERE id = $1', [Number(pos[0])]);
    if (!rows[0]) throw new Error(`course version ${pos[0]} not found`);
    const out = pos[1] ? rows[0].content.weeks[Number(pos[1]) - 1] : rows[0].content;
    console.log(JSON.stringify(out, null, 2));
  } else if (cmd === 'publish') {
    if (!/^\d+$/.test(pos[0] || '')) usage();
    const v = await courseModel.publishVersion(Number(pos[0]), validateCourse);
    console.log(`✓ Published course ${v.course_id} v${v.version} (version id ${v.id}). New roadmaps for this track × level now use it with 0 AI calls.`);
  } else {
    usage();
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(`✗ ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
