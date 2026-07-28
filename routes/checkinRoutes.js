const express = require('express');
const router = express.Router();
const checkinController = require('../controllers/checkinController');

router.post('/roadmaps/:roadmapId/checkin', checkinController.createCheckinEntry);

module.exports = router;