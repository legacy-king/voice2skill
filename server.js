const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const pool = require('./config/db');
const userRoutes = require('./routes/userRoutes');
const trackRoutes = require('./routes/trackRoutes');
const app = express();
require('dotenv').config();
const roadmapRoutes = require('./routes/roadmapRoutes');
const checkinRoutes = require('./routes/checkinRoutes');
const reminderRoutes = require('./routes/reminderRoutes');
const assessmentRoutes = require('./routes/assessmentRoutes');
const cohortRoutes = require('./routes/cohortRoutes');
const { paystackWebhook } = require('./controllers/cohortController');
const { loadEntitlements } = require('./middleware/entitlements');
const { securityHeaders, csrfProtection, touchLastActive } = require('./middleware/security');

// Never run with a forgeable session secret in production — a known constant
// would let anyone mint session cookies and take over any account.
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required in production — refusing to start.');
}
// Mock mode fakes successful payments and AI replies — in production that would hand out paid
// access for free, so refuse to start rather than trust the env to be right.
if (process.env.NODE_ENV === 'production'
    && (process.env.PAYSTACK_MOCK === '1' || process.env.MENTOR_MOCK === '1')) {
  throw new Error('PAYSTACK_MOCK / MENTOR_MOCK must not be set in production — refusing to start.');
}
if (!process.env.SESSION_SECRET) {
  console.warn('⚠  SESSION_SECRET is not set — using a dev-only fallback. Set it in production!');
}

app.set('view engine', 'ejs');
app.set('trust proxy', 1); // behind Render/Heroku proxy — required for req.ip + secure cookies
// Paystack webhook: needs the RAW body for signature checking, and no session/CSRF — so it is
// mounted before everything else. Authenticity comes from the HMAC signature, not a cookie.
app.post('/webhooks/paystack', express.raw({ type: 'application/json', limit: '100kb' }), paystackWebhook);
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(express.json({ limit: '10kb' })); // mentor chat posts JSON
app.use(express.static('public'));
// Public base URL for canonical/OG tags and the sitemap (same default as mailer).
app.use((req, res, next) => {
  res.locals.appUrl = process.env.APP_URL || 'https://voice2skill.onrender.com';
  // Shown on privacy/terms and the landing page's Organizations contact.
  res.locals.supportEmail = process.env.SUPPORT_EMAIL || 'support@voice2skill.com';
  next();
});
app.use(securityHeaders);
app.use(session({
  secret: process.env.SESSION_SECRET || 'insecure-dev-secret-change-me',
  name: 'voice2skill.sid',
  resave: false,
  saveUninitialized: false,
  store: new pgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true // bootstrap the session table if absent
  }),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));
app.use(csrfProtection);
// Throttled last-active tracking for logged-in users (security page).
app.use(touchLastActive());
app.use(loadEntitlements());
app.use('/', userRoutes);
app.use('/', roadmapRoutes);
app.use('/', trackRoutes);
app.use('/', checkinRoutes);
app.use('/', reminderRoutes);
app.use('/', assessmentRoutes);
app.use('/', cohortRoutes);

// 404 + central error handler
app.use((req, res) => {
  res.status(404).send('Page not found');
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong on our end.');
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port http://localhost:3000');
});
