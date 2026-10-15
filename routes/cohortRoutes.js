const express = require('express');
const router = express.Router();
const cohortController = require('../controllers/cohortController');
const mentorController = require('../controllers/mentorController');
const teacherController = require('../controllers/teacherController');
const { rateLimiter } = require('../middleware/security');
const { validate, onInvalid, z, text, id, optional } = require('../middleware/validate');

const cohortIdParam = validate({ params: z.object({ cohortId: id() }) }, onInvalid.notFound);
const teacherCohortParam = validate({ params: z.object({ id: id() }) }, onInvalid.notFound);
// Shape and size only; parseCohortForm (teacherController) applies the business rules.
const cohortFormBody = (base) => validate({
  body: z.object({
    name: text(200), price: text(30), accessDays: text(10),
    curriculum: z.preprocess((v) => (v === undefined ? '' : v), z.string().max(20000)),
    mentorName: text(80), maxSeats: text(10), codeExpires: text(20),
    active: optional(z.literal('on'))
  })
}, onInvalid.redirect(base, { name: 'name', price: 'price', accessDays: 'days', curriculum: 'curriculum', mentorName: 'mentor_name', maxSeats: 'seats', codeExpires: 'code_expiry' }, 'name'));
// Mentor: types and a hard size bound here; the controller keeps its precise error codes.
const mentorBody = validate({
  body: z.object({
    message: z.preprocess((v) => (v === undefined ? '' : v), z.string().max(5000)),
    clientMsgId: z.preprocess((v) => (v === undefined ? '' : v), z.string().max(100))
  })
}, onInvalid.json);

// Joining: tight limit so invite codes can't be brute-forced.
router.get('/join', cohortController.joinPage);
router.post('/join', rateLimiter({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many attempts. Please wait a few minutes.' }),
  validate({ body: z.object({ code: text(40) }) }, onInvalid.redirect('/join', {}, 'invalid_code')),
  cohortController.joinCohort);

// Payments (webhook is mounted separately in server.js, before sessions/CSRF).
// One limiter for both entry points, so Premium and cohort checkouts share the same budget.
const payLimiter = rateLimiter({ max: 10 });
router.post('/premium', payLimiter, cohortController.startPremium);
router.post('/pay/:cohortId', payLimiter, cohortIdParam, cohortController.startPayment);
router.get('/pay/callback',
  validate({ query: z.object({ reference: optional(z.string().max(100).regex(/^[A-Za-z0-9_-]+$/)) }) }, (req, res) => res.redirect('/join')),
  cohortController.paymentCallback);

// AI mentor.
router.get('/mentor', mentorController.mentorPage);
// One limiter for both, so streaming and non-streaming share the same budget.
const mentorLimiter = rateLimiter({ windowMs: 60 * 1000, max: 12, message: 'Slow down a little.' });
router.post('/mentor/message', mentorLimiter, mentorBody, mentorController.sendMessage);
router.post('/mentor/message/stream', mentorLimiter, mentorBody, mentorController.streamMessage);

// Teacher dashboard.
router.get('/teacher', teacherController.teacherHome);
router.post('/teacher/cohorts', rateLimiter({ max: 20 }), cohortFormBody('/teacher'), teacherController.createCohort);
router.get('/teacher/cohorts/:id', teacherCohortParam, teacherController.cohortPage);
router.post('/teacher/cohorts/:id', rateLimiter({ max: 30 }), teacherCohortParam,
  cohortFormBody((req) => `/teacher/cohorts/${req.valid.params.id}`), teacherController.updateCohort);

module.exports = router;
