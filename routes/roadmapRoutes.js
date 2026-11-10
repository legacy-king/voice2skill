const express = require('express');
const router = express.Router();
const roadmapController = require('../controllers/roadmapController');
const { rateLimiter } = require('../middleware/security');
const { validate, onInvalid, z, clipped, id, optional } = require('../middleware/validate');

// POST (not GET): creating a roadmap has a side effect, so it must be
// CSRF-protected and never triggered by a prefetch or a stray link click.
router.post('/tracks/:trackId/select', rateLimiter({ max: 30 }),
  validate({
    params: z.object({ trackId: id() }),
    query: z.object({ assessmentId: optional(id()) }),
    body: z.object({ goal: clipped(200) })
  }, (req, res) => res.status(400).send('Invalid track')),
  roadmapController.selectTrack);
router.get('/roadmaps/:id', validate({ params: z.object({ id: id() }) }, onInvalid.notFound), roadmapController.getRoadmap);
router.get('/roadmaps/:id/days/:day', validate({ params: z.object({ id: id(), day: id() }) }, onInvalid.notFound), roadmapController.getDay);
router.post('/roadmaps/:id/days/:day/quiz/:q', rateLimiter({ max: 60 }),
  validate({
    params: z.object({ id: id(), day: id(), q: id() }),
    body: z.object({ answer: clipped(1000), correct: z.enum(['0', '1']) })
  }, onInvalid.badRequest),
  roadmapController.answerQuiz);

module.exports = router;