const express = require('express');
const router = express.Router();
const assessmentController = require('../controllers/assessmentController');
const { rateLimiter } = require('../middleware/security');

router.get('/tracks/:trackId/assessment', assessmentController.renderAssessment);
router.post('/tracks/:trackId/assessment', rateLimiter({ max: 30 }), assessmentController.processAnswer);
router.get('/tracks/:trackId/assessment/complete', assessmentController.completeAssessment);

module.exports = router;
