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
// Logged-in password change — requires the current password, revokes other sessions.
// Own limiter so current-password guesses never eat into the login budget.
router.get('/change-password', userController.changePasswordPage);
router.post('/change-password', rateLimiter({ max: 20 }), userController.changePassword);
// Security page — lists active sessions and revokes individual devices.
router.get('/security', userController.securityPage);
router.post('/security/revoke', rateLimiter({ max: 30 }), userController.revokeSession);
router.get('/dashboard', userController.dashboard);
router.get('/login', userController.loginPage);
router.get('/signup', userController.signupPage);
router.get('/', (req, res) => {
  res.render('landing');
});

// SEO — sitemap and robots.txt, built from the same appUrl used by OG/canonical tags.
router.get('/sitemap.xml', (req, res) => {
  const base = (res.locals.appUrl || '').replace(/\/$/, '');
  // Only indexable pages belong in the sitemap — everything else is noindex.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc></url>
</urlset>`;
  res.type('application/xml').send(xml);
});

router.get('/robots.txt', (req, res) => {
  const base = (res.locals.appUrl || '').replace(/\/$/, '');
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\n\n` +
    `# App/auth routes are noindex via meta tags; block the obvious private paths too.\n` +
    `Disallow: /dashboard\nDisallow: /tracks\nDisallow: /roadmaps\nDisallow: /security\nDisallow: /change-password\n\n` +
    `Sitemap: ${base}/sitemap.xml\n`
  );
});

// POST, not GET: destroying a session is a state change and must be CSRF-protected.
router.post('/logout', rateLimiter({ max: 30 }), userController.logout);

module.exports = router;