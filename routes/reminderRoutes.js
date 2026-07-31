const express = require('express');
const router = express.Router();
const reminderController = require('../controllers/reminderController');

router.get('/api/send-reminders', reminderController.sendDailyReminders);

module.exports = router;