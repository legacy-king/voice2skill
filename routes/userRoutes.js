const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { rateLimiter } = require('../middleware/security');

const authLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many attempts. Please wait a few minutes and try again.' });

router.post('/signup', authLimiter, userController.signup);
router.post('/login', authLimiter, userController.login);
router.post('/dashboard/goal', rateLimiter({ max: 30 }), userController.matchGoal);
router.get('/verify-email', userController.verifyEmailPage);
router.get('/verify-email/confirm', userController.confirmEmail);
router.post('/verify-email/resend', rateLimiter({ windowMs: 15 * 60 * 1000, max: 10 }), userController.resendVerification);
router.get('/forgot-password', userController.forgotPasswordPage);
router.post('/forgot-password', authLimiter, userController.requestPasswordReset);
router.get('/reset-password', userController.resetPasswordPage);
router.post('/reset-password', authLimiter, userController.resetPassword);
router.get('/dashboard', userController.dashboard);
router.get('/login', userController.loginPage);
router.get('/signup', userController.signupPage);
router.get('/', (req, res) => {
  res.render('landing');
});

// POST, not GET: destroying a session is a state change and must be CSRF-protected.
router.post('/logout', rateLimiter({ max: 30 }), userController.logout);

module.exports = router;