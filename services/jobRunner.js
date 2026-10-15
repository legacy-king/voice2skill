/**
 * In-process background job runner (ADR-001). Polls the `jobs` table and runs ONE job at a time,
 * so a long job never starves web requests (each AI call inside a job has its own timeout).
 *
 * Claiming uses FOR UPDATE SKIP LOCKED, so any number of web instances or a CLI script can run
 * the loop at once without picking the same job. A job whose process died is reclaimed once its
 * heartbeat (locked_at) is older than JOB_STALE_MINUTES. Failures retry with exponential backoff
 * until max_attempts, then the job is marked 'failed' with last_error.
 *
 * Env: JOBS_DISABLED=1 (don't start the loop in this process), JOB_POLL_MS (default 15000),
 * JOB_STALE_MINUTES (default 15).
 */
const pool = require('../config/db');

const handlers = {
  course_gen: (...args) => require('./courseGenerator').runCourseJob(...args)
};

const STALE_MINUTES = () => Number(process.env.JOB_STALE_MINUTES) || 15;

/** Idempotent while pending: a second enqueue with the same dedupeKey returns the existing job. */
async function enqueue(kind, payload, { dedupeKey = null, maxAttempts = 3 } = {}) {
  if (!handlers[kind]) throw new Error(`unknown job kind "${kind}"`);
  const ins = await pool.query(
    `INSERT INTO jobs (kind, payload, dedupe_key, max_attempts) VALUES ($1, $2, $3, $4)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running') DO NOTHING
     RETURNING *`,
    [kind, JSON.stringify(payload), dedupeKey, maxAttempts]
  );
  if (ins.rows[0]) return { job: ins.rows[0], created: true };
  const { rows } = await pool.query(
    "SELECT * FROM jobs WHERE dedupe_key = $1 AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1",
    [dedupeKey]
  );
  return { job: rows[0], created: false };
}

async function claim() {
  const { rows } = await pool.query(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = NOW(), updated_at = NOW()
      WHERE id = (
        SELECT id FROM jobs
         WHERE (status = 'queued' AND run_after <= NOW())
            OR (status = 'running' AND locked_at < NOW() - make_interval(mins => $1))
         ORDER BY run_after, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      RETURNING *`,
    [STALE_MINUTES()]
  );
  return rows[0] || null;
}

/** Claims and runs at most one job. Returns the finished job row, or null if none was ready. */
async function runOnce() {
  const job = await claim();
  if (!job) return null;
  const handler = handlers[job.kind];
  // Progress also refreshes the heartbeat so a long job is not reclaimed as stale.
  const saveProgress = async (result) => {
    await pool.query("UPDATE jobs SET result = $2, locked_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'running'", [job.id, JSON.stringify(result)]);
    job.result = result;
  };
  try {
    if (!handler) throw new Error(`no handler for job kind "${job.kind}"`);
    const result = await handler(job, { saveProgress });
    const { rows } = await pool.query(
      "UPDATE jobs SET status = 'done', result = $2, last_error = NULL, locked_at = NULL, updated_at = NOW() WHERE id = $1 RETURNING *",
      [job.id, JSON.stringify(result ?? null)]
    );
    return rows[0];
  } catch (err) {
    const message = String(err && err.message ? err.message : err).slice(0, 1000);
    console.error(`Job ${job.id} (${job.kind}) attempt ${job.attempts} failed: ${message}`);
    const { rows } = await pool.query(
      `UPDATE jobs
          SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
              run_after = NOW() + make_interval(mins => LEAST(60, POWER(2, attempts)::int)),
              last_error = $2, locked_at = NULL, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [job.id, message]
    );
    return rows[0];
  }
}

let timer = null;
let busy = false;

/** Starts the polling loop in this process (call once from server.js). */
function start({ intervalMs = Number(process.env.JOB_POLL_MS) || 15000 } = {}) {
  if (timer || process.env.JOBS_DISABLED === '1') return;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      // Drain whatever is ready, one job at a time.
      while (timer && await runOnce()) { /* next */ }
    } catch (err) {
      console.error('Job runner error:', err.message);
    } finally {
      busy = false;
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref();
  setTimeout(tick, 1000).unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { enqueue, claim, runOnce, start, stop, handlers };
