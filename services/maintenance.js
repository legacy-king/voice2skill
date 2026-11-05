/**
 * Small housekeeping that runs inside the web process on a slow timer (one cheap query each).
 *
 * pruneAnonymousSessions: sessions of visitors who never logged in (bots, crawlers, someone who
 * opened the login page and left) hold nothing but a CSRF token, yet connect-pg-simple keeps each
 * for the full cookie lifetime (7 days). Deleting them after SESSION_ANON_KEEP_DAYS (default 1)
 * keeps the session table small. A visitor in the middle of signing up has hours, not seconds.
 * Logged-in sessions are never touched. Created time is not stored, but an untouched anonymous
 * session expires exactly SESSION_DAYS after it was created, so age = SESSION_DAYS - time left.
 *
 * Env: MAINTENANCE_DISABLED=1 (don't start the timer), MAINTENANCE_INTERVAL_MS (default 6 h),
 * SESSION_ANON_KEEP_DAYS (default 1).
 */
const pool = require('../config/db');
const { log } = require('../utils/log');

const SESSION_DAYS = 7; // keep equal to the cookie maxAge in server.js
const BATCH = 2000;     // bounded work per pass; the next pass continues if there is more

async function pruneAnonymousSessions() {
  const keepDays = Math.min(SESSION_DAYS - 1, Math.max(0, Number(process.env.SESSION_ANON_KEEP_DAYS) || 1));
  let total = 0;
  // Batched so one pass never holds a long lock or does an unbounded amount of work.
  for (let i = 0; i < 25; i++) {
    const { rowCount } = await pool.query(
      `DELETE FROM "session"
        WHERE sid IN (
          SELECT sid FROM "session"
           WHERE sess::jsonb ->> 'userId' IS NULL
             AND expire < NOW() + make_interval(days => $1)
           LIMIT $2)`,
      [SESSION_DAYS - keepDays, BATCH]
    );
    total += rowCount;
    if (rowCount < BATCH) break;
  }
  return total;
}

async function runMaintenance() {
  try {
    const removed = await pruneAnonymousSessions();
    if (removed > 0) log.info('Pruned anonymous sessions', { removed });
  } catch (err) {
    log.warn('Maintenance pass failed', { error: err.message });
  }
}

let timer = null;
let first = null;

function start({ intervalMs = Number(process.env.MAINTENANCE_INTERVAL_MS) || 6 * 60 * 60 * 1000 } = {}) {
  if (timer || process.env.MAINTENANCE_DISABLED === '1') return;
  timer = setInterval(runMaintenance, intervalMs);
  timer.unref();
  first = setTimeout(runMaintenance, 2 * 60 * 1000); // not during boot
  first.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  if (first) clearTimeout(first);
  timer = first = null;
}

module.exports = { pruneAnonymousSessions, runMaintenance, start, stop, SESSION_DAYS };
