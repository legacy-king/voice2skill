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
const voiceRoutes = require('./routes/voiceRoutes');
const adminRoutes = require('./routes/adminRoutes');
const healthRoutes = require('./routes/healthRoutes');
const { paystackWebhook } = require('./controllers/cohortController');
const { loadEntitlements } = require('./middleware/entitlements');
const { securityHeaders, csrfProtection, apiCors, touchLastActive } = require('./middleware/security');
const { log, requestContext, attachUser } = require('./utils/log');

// Never run with a forgeable session secret in production — a known constant
// would let anyone mint session cookies and take over any account.
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required in production — refusing to start.');
}
// Mock mode fakes successful payments and AI replies — in production that would hand out paid
// access for free, so refuse to start rather than trust the env to be right.
if (process.env.NODE_ENV === 'production'
    && (process.env.PAYSTACK_MOCK === '1' || process.env.MENTOR_MOCK === '1' || process.env.COURSE_MOCK === '1')) {
  throw new Error('PAYSTACK_MOCK / MENTOR_MOCK / COURSE_MOCK must not be set in production — refusing to start.');
}
if (!process.env.SESSION_SECRET) {
  log.warn('SESSION_SECRET is not set — using a dev-only fallback. Set it in production!');
}

app.set('view engine', 'ejs');
app.set('trust proxy', 1); // behind Render/Heroku proxy — required for req.ip + secure cookies
app.disable('x-powered-by');
// Request id + one structured log line per request (static files are not logged).
app.use(requestContext({ skip: (req) => /^\/(css|js|img|favicon)/.test(req.path) || req.path === '/health' }));
// Security headers (helmet + CSP) on everything, static files included.
app.use(securityHeaders());
// Health check: before sessions, so monitors never create session rows.
app.use('/', healthRoutes);
// Paystack webhook: needs the RAW body for signature checking, and no session/CSRF — so it is
// mounted before the body parsers. Authenticity comes from the HMAC signature, not a cookie.
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
app.use('/api', apiCors);
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
app.use(attachUser);
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
app.use('/', voiceRoutes);
app.use('/', adminRoutes);

// 404 + central error handler
app.use((req, res) => {
  res.status(404).send('Page not found');
});

// Never send stack traces or error text to users. Client errors raised by Express itself (bad JSON,
// body too large) keep their 4xx status with a generic message; everything else is a logged 500.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err.status || err.statusCode);
  if (status >= 400 && status < 500) {
    log.warn('client error', { status, type: err.type || err.name });
    return req.path.startsWith('/api/') || req.is('application/json')
      ? res.status(status).json({ error: 'bad_request' })
      : res.status(status).send('Bad request.');
  }
  log.error('unhandled error', err);
  res.status(500).send('Something went wrong on our end.');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  log.info(`Server running on port ${port}`);
});

// Background jobs (Course Library generation, daily reminders) run in this process, one at a time.
// Set JOBS_DISABLED=1 to keep a process out of the queue.
require('./services/jobRunner').start();
