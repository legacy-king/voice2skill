const express = require('express');
const router = express.Router();
const roadmapController = require('../controllers/roadmapController');

router.get('/tracks/:trackId/select', roadmapController.selectTrack);
router.get('/roadmaps/:id', roadmapController.getRoadmap);

module.exports = router;