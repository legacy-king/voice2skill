const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// Render and any uptime monitor hit this every few seconds. Probing the database each time keeps a
// scale-to-zero Neon compute awake around the clock and spends a pool connection per check, so the
// result is reused for a few seconds and concurrent checks share one probe.
const CACHE_MS = Number(process.env.HEALTH_CACHE_MS) || 5000;
let cached = { at: 0, ok: false };
let inFlight = null;

function probe() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let timer;
    try {
      await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('db timeout')), 3000); })
      ]);
      cached = { at: Date.now(), ok: true };
    } catch {
      cached = { at: Date.now(), ok: false };
    } finally {
      clearTimeout(timer);
      inFlight = null;
    }
    return cached.ok;
  })();
  return inFlight;
}

/**
 * GET /health — for Render's health check and uptime monitors. Mounted before sessions, so it
 * never touches the session table. Says only whether the app and database answer: no version,
 * config, env or error details.
 */
router.get('/health', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const fresh = Date.now() - cached.at < CACHE_MS;
  const ok = fresh ? cached.ok : await probe();
  res.status(ok ? 200 : 503).json({ ok });
});

module.exports = router;
