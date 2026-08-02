const crypto = require('crypto');
const bcrypt = require('bcrypt');
const userModel = require('../models/userModel');
const roadmapModel = require('../models/roadmapModel');
const trackModel = require('../models/trackModel');
const { sendVerificationEmail } = require('../utils/mailer');
const { rankTracksForGoal } = require('../utils/goalMatcher');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GLYPHS = ['</>', '✦', '∑', '◎', '⚿'];
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

async function signup(req, res) {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (!name || name.length > 100) {
    return res.redirect('/signup?error=name');
  }
  if (!EMAIL_RE.test(email) || email.length > 150) {
    return res.redirect('/signup?error=email');
  }
  if (password.length < 8) {
    return res.redirect('/signup?error=password');
  }

  const existingUser = await userModel.findUserByEmail(email);
  if (existingUser && existingUser.email_verified) {
    return res.redirect('/signup?error=taken');
  }

  // Re-signup with an UNVERIFIED email is a retry, not a collision:
  // regenerate the token, re-send the link, and point them at the inbox
  // instead of a dead-end "already registered" message.
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + VERIFY_TTL_MS);

  if (existingUser) {
    await userModel.setVerificationToken(existingUser.id, token, expiresAt);
  } else {
    const passwordHash = await bcrypt.hash(password, 10);
    await userModel.createUser(name, email, passwordHash, token, expiresAt);
  }

  try {
    await sendVerificationEmail(email, name, token);
  } catch (err) {
    console.error('Failed to send verification email:', err.message);
    return res.redirect('/verify-email?error=send_failed');
  }

  // Do NOT auto-login — require verification first.
  res.redirect('/verify-email?sent=1');
}

async function login(req, res) {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (!email || !password) {
    return res.redirect('/login?error=missing');
  }

  const existingUser = await userModel.findUserByEmail(email);
  if (!existingUser) {
    return res.redirect('/login?error=not_found');
  }

  const passwordMatches = await bcrypt.compare(password, existingUser.password_hash);
  if (!passwordMatches) {
    return res.redirect('/login?error=wrong_password');
  }

  if (!existingUser.email_verified) {
    return res.redirect('/login?error=not_verified');
  }

  // Regenerate the session on privilege elevation to prevent session fixation.
  req.session.regenerate((err) => {
    if (err) return res.status(500).send('Something went wrong on our end.');
    req.session.userId = existingUser.id;
    res.redirect('/dashboard');
  });
}

/** GET /verify-email — info + resend page. */
async function verifyEmailPage(req, res) {
  const sent = req.query.sent === '1';
  const error = req.query.error || null;
  res.render('verify-email', { sent, error });
}

/** GET /verify-email/confirm?token=... — confirms and logs the user in. */
async function confirmEmail(req, res) {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) {
    return res.redirect('/verify-email?error=invalid');
  }

  const user = await userModel.findUserByVerificationToken(token);
  if (!user) {
    return res.redirect('/verify-email?error=invalid');
  }

  await userModel.markEmailVerified(user.id);

  // New session on privilege elevation (prevents session fixation).
  req.session.regenerate((err) => {
    if (err) return res.status(500).send('Something went wrong on our end.');
    req.session.userId = user.id;
    res.redirect('/dashboard');
  });
}

/** POST /verify-email/resend — regenerates the token and re-sends. */
async function resendVerification(req, res) {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email)) {
    return res.redirect('/verify-email?error=invalid_email');
  }

  const user = await userModel.findUserByEmail(email);
  // Don't leak whether an email exists — same redirect either way.
  if (user && !user.email_verified) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + VERIFY_TTL_MS);
    await userModel.setVerificationToken(user.id, token, expiresAt);
    try {
      await sendVerificationEmail(email, user.name, token);
    } catch (err) {
      console.error('Failed to resend verification email:', err.message);
      return res.redirect('/verify-email?error=send_failed');
    }
  }

  res.redirect('/verify-email?sent=1');
}

  async function dashboard(req, res) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const user = await userModel.findUserById(req.session.userId);
  const existingRoadmap = await roadmapModel.getRoadmapByUser(req.session.userId);

  if (existingRoadmap) {
    return res.redirect(`/roadmaps/${existingRoadmap.id}`);
  }

  const tracks = await trackModel.getAllTracks();
  const goalError = req.query.goalError || null;
  const goalValue = String(req.query.goal || '');

  res.render('dashboard', { user, tracks, goalError, goalValue });
}

async function matchGoal(req, res) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const goal = typeof req.body.goal === 'string' ? req.body.goal.trim().slice(0, 200) : '';
  if (!goal) {
    return res.redirect('/dashboard?goalError=empty');
  }

  const tracks = await trackModel.getAllTracks();
  const ranked = rankTracksForGoal(goal, tracks);

  if (ranked.length === 0) {
    return res.redirect(`/dashboard?goalError=no_match&goal=${encodeURIComponent(goal)}`);
  }

  const matchedTrack = ranked[0].track;
  const alternatives = ranked.slice(1, 4).map((entry) => ({
    ...entry.track,
    matchLabel: entry.points >= 3 ? 'strong' : 'possible'
  }));

  // Confirmation step: show which track we matched (and next-best options) before building the roadmap.
  res.render('goal-confirm', { goal, track: matchedTrack, alternatives, glyphs: GLYPHS });
}

function loginPage(req, res) {
  const error = req.query.error;
  res.render('login', { error });
}

function signupPage(req, res) {
  res.render('signup');
}

function logout(req, res) {
  req.session.destroy(() => {
    res.redirect('/login');
  });
}

module.exports = { signup, login, dashboard, matchGoal, verifyEmailPage, confirmEmail, resendVerification, loginPage, signupPage, logout };