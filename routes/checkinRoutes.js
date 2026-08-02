const express = require('express');
const router = express.Router();
const checkinController = require('../controllers/checkinController');
const { rateLimiter } = require('../middleware/security');

router.post('/roadmaps/:roadmapId/checkin', rateLimiter({ max: 60 }), checkinController.createCheckinEntry);

module.exports = router;