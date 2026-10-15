const express = require('express');
const router = express.Router();
const assessmentController = require('../controllers/assessmentController');
const { rateLimiter } = require('../middleware/security');
const { validate, z, text, clipped, id } = require('../middleware/validate');

const trackParam = { params: z.object({ trackId: id() }) };
const badTrack = (req, res) => res.status(400).send('Invalid track');

router.get('/tracks/:trackId/assessment', validate(trackParam, badTrack), assessmentController.renderAssessment);
router.post('/tracks/:trackId/assessment', rateLimiter({ max: 30 }),
  validate({ ...trackParam, body: z.object({ questionId: text(64), answer: text(64), goal: clipped(200) }) }, badTrack),
  assessmentController.processAnswer);
router.get('/tracks/:trackId/assessment/complete', validate(trackParam, badTrack), assessmentController.completeAssessment);

module.exports = router;
