const express = require('express');
const session = require('express-session');
const userRoutes = require('./routes/userRoutes');
const trackRoutes = require('./routes/trackRoutes');
const app = express();
require('dotenv').config();
const roadmapRoutes = require('./routes/roadmapRoutes');
const checkinRoutes = require('./routes/checkinRoutes');
const reminderRoutes = require('./routes/reminderRoutes');
const { securityHeaders, csrfProtection } = require('./middleware/security');

// Never run with a forgeable session secret in production — a known constant
// would let anyone mint session cookies and take over any account.
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required in production — refusing to start.');
}
if (!process.env.SESSION_SECRET) {
  console.warn('⚠  SESSION_SECRET is not set — using a dev-only fallback. Set it in production!');
}

app.set('view engine', 'ejs');
app.set('trust proxy', 1); // behind Render/Heroku proxy — required for req.ip + secure cookies
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(express.static('public'));
app.use(securityHeaders);
app.use(session({
  secret: process.env.SESSION_SECRET || 'insecure-dev-secret-change-me',
  name: 'voice2skill.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));
app.use(csrfProtection);
app.use('/', userRoutes);
app.use('/', roadmapRoutes);
app.use('/', trackRoutes);
app.use('/', checkinRoutes);
app.use('/', reminderRoutes);

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
