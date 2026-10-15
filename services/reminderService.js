/**
 * Daily "don't break your streak" emails (audit finding A7), run as a background job so the cron
 * request returns at once and a slow email provider never holds a web request open.
 *
 * Who gets one: verified users with an unfinished roadmap (fewer than 56 check-ins) who are
 * ACTIVE (checked in within REMINDER_ACTIVE_DAYS, default 7, or started the roadmap within that
 * time), have not checked in today, and have not already been reminded today.
 * Idempotent per user per day via email_log (claimed before sending, released if the send fails).
 * At most REMINDER_DAILY_CAP (default 250) per day, leaving room in Brevo's free 300/day for
 * verification and password emails.
 */
const pool = require('../config/db');
const { sendReminderEmail } = require('./mailer');
const { log } = require('../utils/log');

const ACTIVE_DAYS = () => Math.max(1, Number(process.env.REMINDER_ACTIVE_DAYS) || 7);
const DAILY_CAP = () => Math.max(1, Number(process.env.REMINDER_DAILY_CAP) || 250);
const PLAN_DAYS = 56;

async function findRecipients(limit) {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email
       FROM users u
      WHERE u.email_verified
        AND NOT EXISTS (SELECT 1 FROM checkins c WHERE c.user_id = u.id AND c.checkin_date = CURRENT_DATE)
        AND NOT EXISTS (SELECT 1 FROM email_log e WHERE e.user_id = u.id AND e.kind = 'reminder' AND e.day = CURRENT_DATE)
        AND EXISTS (
          SELECT 1 FROM roadmaps r
           WHERE r.user_id = u.id
             AND (SELECT COUNT(*) FROM checkins c WHERE c.roadmap_id = r.id) < $3
             AND (r.created_at >= NOW() - make_interval(days => $1)
                  OR EXISTS (SELECT 1 FROM checkins c WHERE c.roadmap_id = r.id AND c.checkin_date >= CURRENT_DATE - $1::int))
        )
      ORDER BY u.id
      LIMIT $2`,
    [ACTIVE_DAYS(), limit, PLAN_DAYS]
  );
  return rows;
}

/** Job handler for kind 'reminders'. */
async function runReminderJob(job, { saveProgress }) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM email_log WHERE kind = 'reminder' AND day = CURRENT_DATE");
  const budget = DAILY_CAP() - rows[0].n;
  if (budget <= 0) return { sent: 0, failed: 0, skipped: 'daily_cap' };

  const recipients = await findRecipients(budget);
  let sent = 0;
  let failed = 0;
  for (const user of recipients) {
    // Claim first: a concurrent run (or a retried job) can't send the same user a second email.
    const claim = await pool.query(
      "INSERT INTO email_log (user_id, kind, day) VALUES ($1, 'reminder', CURRENT_DATE) ON CONFLICT DO NOTHING RETURNING id",
      [user.id]
    );
    if (!claim.rowCount) continue;
    try {
      await sendReminderEmail(user.email, user.name);
      sent++;
    } catch (err) {
      failed++;
      log.error('Reminder email failed', { userId: user.id, error: err.message });
      await pool.query('DELETE FROM email_log WHERE id = $1', [claim.rows[0].id]).catch(() => {});
    }
    if ((sent + failed) % 25 === 0) await saveProgress({ sent, failed });
  }
  log.info('Reminder run finished', { sent, failed, candidates: recipients.length });
  return { sent, failed };
}

module.exports = { runReminderJob, findRecipients };
