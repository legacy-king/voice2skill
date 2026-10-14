const express = require('express');
const router = express.Router();
const cohortController = require('../controllers/cohortController');
const mentorController = require('../controllers/mentorController');
const teacherController = require('../controllers/teacherController');
const { rateLimiter } = require('../middleware/security');

// Joining: tight limit so invite codes can't be brute-forced.
router.get('/join', cohortController.joinPage);
router.post('/join', rateLimiter({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many attempts. Please wait a few minutes.' }), cohortController.joinCohort);

// Payments (webhook is mounted separately in server.js, before sessions/CSRF).
// One limiter for both entry points, so Premium and cohort checkouts share the same budget.
const payLimiter = rateLimiter({ max: 10 });
router.post('/premium', payLimiter, cohortController.startPremium);
router.post('/pay/:cohortId', payLimiter, cohortController.startPayment);
router.get('/pay/callback', cohortController.paymentCallback);

// AI mentor.
router.get('/mentor', mentorController.mentorPage);
router.post('/mentor/message', rateLimiter({ windowMs: 60 * 1000, max: 12, message: 'Slow down a little.' }), mentorController.sendMessage);

// Teacher dashboard.
router.get('/teacher', teacherController.teacherHome);
router.post('/teacher/cohorts', rateLimiter({ max: 20 }), teacherController.createCohort);
router.get('/teacher/cohorts/:id', teacherController.cohortPage);
router.post('/teacher/cohorts/:id', rateLimiter({ max: 30 }), teacherController.updateCohort);

module.exports = router;
