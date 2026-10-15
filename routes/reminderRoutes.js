const express = require('express');
const router = express.Router();
const reminderController = require('../controllers/reminderController');
const { rateLimiter } = require('../middleware/security');

// GET (not POST): the cron has no session, so it can't pass CSRF. The secret header is the guard;
// the limiter stops secret guessing.
router.get('/api/send-reminders', rateLimiter({ windowMs: 15 * 60 * 1000, max: 10 }), reminderController.sendDailyReminders);

module.exports = router;
