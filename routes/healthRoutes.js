const express = require('express');
const router = express.Router();
const pool = require('../config/db');

/**
 * GET /health — for Render's health check and uptime monitors. Mounted before sessions, so it
 * never touches the session table. Says only whether the app and database answer: no version,
 * config, env or error details.
 */
router.get('/health', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  let timer;
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('db timeout')), 3000); })
    ]);
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  } finally {
    clearTimeout(timer);
  }
});

module.exports = router;
