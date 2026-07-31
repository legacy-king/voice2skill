const pool = require('../config/db');
const { sendReminderEmail } = require('../utils/mailer');

async function sendDailyReminders(req, res) {
  const secret = req.query.key;
  if (secret !== process.env.CRON_SECRET) {
    return res.status(403).send('Forbidden');
  }

  const today = new Date().toISOString().split('T')[0];

  const result = await pool.query(`
    SELECT DISTINCT u.id, u.name, u.email
    FROM users u
    JOIN roadmaps r ON r.user_id = u.id
    WHERE u.id NOT IN (
      SELECT user_id FROM checkins WHERE checkin_date = $1
    )
  `, [today]);

  const usersToRemind = result.rows;

  for (const user of usersToRemind) {
    try {
      await sendReminderEmail(user.email, user.name);
      console.log(`Reminder sent to ${user.email}`);
    } catch (err) {
      console.error(`Failed to email ${user.email}:`, err.message);
    }
  }

  res.send(`Sent ${usersToRemind.length} reminder(s).`);
}

module.exports = { sendDailyReminders };