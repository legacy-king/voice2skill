const crypto = require('crypto');
const jobRunner = require('../services/jobRunner');
const { log } = require('../utils/log');

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * GET /api/send-reminders — called once a day by an external cron.
 * The secret goes in the X-Cron-Secret header (URLs end up in proxy logs). The old ?key= query
 * parameter still works for now so the existing cron doesn't break, but logs a warning: move the
 * cron to the header, then set CRON_ALLOW_QUERY_KEY=0.
 *
 * Only queues the day's job (idempotent: one job per day) and answers 202 straight away; the job
 * runner sends the emails (services/reminderService.js).
 */
async function sendDailyReminders(req, res) {
  const expected = process.env.CRON_SECRET;
  const header = req.get('x-cron-secret');
  const query = process.env.CRON_ALLOW_QUERY_KEY === '0' ? undefined : req.query.key;
  const given = typeof header === 'string' ? header : (typeof query === 'string' ? query : null);
  if (!expected || given === null || !safeEqual(given, expected)) {
    return res.status(403).send('Forbidden');
  }
  if (typeof header !== 'string') log.warn('Reminder cron used the ?key= query parameter; switch it to the X-Cron-Secret header.');

  const day = new Date().toISOString().slice(0, 10);
  const { job, created } = await jobRunner.enqueue('reminders', { day }, { dedupeKey: `reminders:${day}`, maxAttempts: 3 });
  res.status(202).json({ queued: true, job: job.id, alreadyQueued: !created });
}

module.exports = { sendDailyReminders };
