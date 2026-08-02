const express = require('express');
const router = express.Router();
const roadmapController = require('../controllers/roadmapController');
const { rateLimiter } = require('../middleware/security');

// POST (not GET): creating a roadmap has a side effect, so it must be
// CSRF-protected and never triggered by a prefetch or a stray link click.
router.post('/tracks/:trackId/select', rateLimiter({ max: 30 }), roadmapController.selectTrack);
router.get('/roadmaps/:id', roadmapController.getRoadmap);

module.exports = router;