const express = require('express');
const router = express.Router();
const voiceController = require('../controllers/voiceController');
const { rateLimiter } = require('../middleware/security');

// JSON API (usable by a future React client). CSRF comes from the X-CSRF-Token header (global
// middleware). Login and rate limit run before the upload is read.
router.post('/api/voice/transcribe',
  voiceController.requireLogin,
  rateLimiter({ windowMs: 60 * 1000, max: 10, message: 'Too many voice clips. Wait a minute.' }),
  voiceController.readAudio,
  voiceController.transcribe);

module.exports = router;
