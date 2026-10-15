const express = require('express');
const router = express.Router();
const checkinController = require('../controllers/checkinController');
const { rateLimiter } = require('../middleware/security');
const { validate, onInvalid, z, clipped, id } = require('../middleware/validate');

router.post('/roadmaps/:roadmapId/checkin', rateLimiter({ max: 60 }),
  validate({ params: z.object({ roadmapId: id() }), body: z.object({ notes: clipped(2000) }) }, onInvalid.notFound),
  checkinController.createCheckinEntry);

module.exports = router;