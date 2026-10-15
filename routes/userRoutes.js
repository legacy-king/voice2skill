const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { rateLimiter, loginEmailLimiter, resetEmailLimiter } = require('../middleware/security');
const { validate, onInvalid, z, text, clipped, secret, email, hexToken } = require('../middleware/validate');
const cohortModel = require('../models/cohortModel');
const { naira } = require('../utils/format');
const { log } = require('../utils/log');

const authLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: Number(process.env.AUTH_RATE_MAX) || 60, message: 'Too many attempts. Please wait a few minutes and try again.' });

// ---- input schemas (zod). Controllers read req.valid only. ----
const signupSchema = validate(
  { body: z.object({ name: text(100), email: email(), password: secret(), code: text(20) }) },
  (req, res, { field }) => {
    const key = { name: 'name', email: 'email', password: 'password', code: 'code_invalid' }[field] || 'name';
    const code = cohortModel.normalizeCode(req.body && req.body.code);
    res.redirect(`/signup?error=${key}${code ? `&code=${code}` : ''}`);
  }
);
const loginSchema = validate({ body: z.object({ email: email(), password: secret() }) }, onInvalid.redirect('/login', {}, 'missing'));
const emailOnly = (base) => validate({ body: z.object({ email: email() }) }, onInvalid.redirect(base, {}, 'invalid_email'));
const tokenQuery = (onBad) => validate({ query: z.object({ token: hexToken() }) }, onBad);

router.post('/signup', authLimiter, signupSchema, userController.signup);
router.post('/login', authLimiter, loginSchema, loginEmailLimiter, userController.login);
router.post('/dashboard/goal', rateLimiter({ max: 30 }),
  validate({ body: z.object({ goal: clipped(200) }) }, (req, res) => res.redirect('/dashboard?goalError=empty')),
  userController.matchGoal);
router.get('/verify-email', userController.verifyEmailPage);
router.get('/verify-email/confirm', tokenQuery((req, res) => res.redirect('/verify-email?error=invalid')), userController.confirmEmail);
router.post('/verify-email/resend', rateLimiter({ windowMs: 15 * 60 * 1000, max: 10 }), emailOnly('/verify-email'), resetEmailLimiter, userController.resendVerification);
router.get('/forgot-password', userController.forgotPasswordPage);
router.post('/forgot-password', authLimiter, emailOnly('/forgot-password'), resetEmailLimiter, userController.requestPasswordReset);
router.get('/reset-password', tokenQuery((req, res) => res.redirect('/forgot-password?error=invalid_token')), userController.resetPasswordPage);
router.post('/reset-password', authLimiter,
  validate({ body: z.object({ token: hexToken(), password: secret() }) }, onInvalid.redirect('/forgot-password', {}, 'expired_token')),
  userController.resetPassword);
// Logged-in password change — requires the current password, revokes other sessions.
// Own limiter so current-password guesses never eat into the login budget.
router.get('/change-password', userController.changePasswordPage);
router.post('/change-password', rateLimiter({ max: 20 }),
  validate({ body: z.object({ current_password: secret(), new_password: secret() }) }, onInvalid.redirect('/change-password', {}, 'missing')),
  userController.changePassword);
// Security page — lists active sessions and revokes individual devices.
router.get('/security', userController.securityPage);
router.post('/security/revoke', rateLimiter({ max: 30 }),
  validate({ body: z.object({ sid: text(128) }) }, onInvalid.redirect('/security', {}, 'missing')),
  userController.revokeSession);
router.get('/dashboard', userController.dashboard);
router.get('/login', userController.loginPage);
router.get('/signup', userController.signupPage);
router.get('/', async (req, res) => {
  // Premium's price lives in the DB (cohorts.kind = 'premium'); the page falls back to the
  // launch price if the DB is unreachable, so the landing page never fails to render.
  let premiumPrice = null;
  try {
    const premium = await cohortModel.getPremiumCohort();
    if (premium && premium.active) premiumPrice = naira(premium.price_kobo);
  } catch (err) {
    log.error('Landing: premium price lookup failed:', err.message);
  }
  res.render('landing', { premiumPrice });
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
router.get('/privacy', (req, res) => res.render('privacy', {}));
router.get('/terms', (req, res) => res.render('terms', {}));

// POST, not GET: destroying a session is a state change and must be CSRF-protected.
router.post('/logout', rateLimiter({ max: 30 }), userController.logout);

module.exports = router;