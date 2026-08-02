const crypto = require('crypto');
const bcrypt = require('bcrypt');
const userModel = require('../models/userModel');
const roadmapModel = require('../models/roadmapModel');
const trackModel = require('../models/trackModel');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../utils/mailer');
const { rankTracksForGoal } = require('../utils/goalMatcher');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GLYPHS = ['</>', '✦', '∑', '◎', '⚿'];
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESET_TTL_MS = 30 * 60 * 1000; // 30 min

/** Record the current device on a session so the security page can label it. */
function stampSession(req) {
  const now = new Date().toISOString();
  req.session.userAgent = String(req.headers['user-agent'] || '').slice(0, 200);
  req.session.ip = req.ip || 'unknown';
  req.session.signedInAt = now;
  req.session.lastActiveAt = now;
}

/** Turn a user-agent string into a short, human-readable device label. */
function describeDevice(ua = '') {
  const s = ua.toLowerCase();
  const os = s.includes('windows') ? 'Windows'
    : s.includes('iphone') || s.includes('ipad') ? 'iOS'
    : s.includes('mac os') || s.includes('macintosh') ? 'macOS'
    : s.includes('android') ? 'Android'
    : s.includes('linux') ? 'Linux'
    : 'Unknown OS';
  const browser = s.includes('edg/') || s.includes('edge/') ? 'Edge'
    : s.includes('chrome/') ? 'Chrome'
    : s.includes('firefox/') ? 'Firefox'
    : s.includes('safari/') ? 'Safari'
    : s.includes('opera/') || s.includes('opr/') ? 'Opera'
    : 'Browser';
  return `${browser} · ${os}`;
}

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
    stampSession(req);
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
    stampSession(req);
    res.redirect('/dashboard');
  });
}

/** GET /forgot-password — email entry form. */
function forgotPasswordPage(req, res) {
  const sent = req.query.sent === '1';
  const error = req.query.error || null;
  res.render('forgot-password', { sent, error });
}

/** POST /forgot-password — send a reset link if the email exists. */
async function requestPasswordReset(req, res) {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email)) {
    return res.redirect('/forgot-password?error=invalid_email');
  }

  const user = await userModel.findUserByEmail(email);
  // Don't leak whether an email exists — same redirect either way.
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TTL_MS);
    await userModel.setPasswordResetToken(user.id, token, expiresAt);
    try {
      await sendPasswordResetEmail(email, user.name, token);
    } catch (err) {
      console.error('Failed to send password reset email:', err.message);
      return res.redirect('/forgot-password?error=send_failed');
    }
  }

  res.redirect('/forgot-password?sent=1');
}

/** GET /reset-password?token=... — show the new-password form. */
async function resetPasswordPage(req, res) {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) {
    return res.redirect('/forgot-password?error=invalid_token');
  }

  const user = await userModel.findUserByPasswordResetToken(token);
  if (!user) {
    return res.redirect('/forgot-password?error=expired_token');
  }

  res.render('reset-password', { token, error: req.query.error || null });
}

/** POST /reset-password — validate token + new password, then update. */
async function resetPassword(req, res) {
  const token = typeof req.body.token === 'string' ? req.body.token : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (password.length < 8) {
    return res.redirect(`/reset-password?token=${encodeURIComponent(token)}&error=weak`);
  }

  const user = await userModel.findUserByPasswordResetToken(token);
  if (!user) {
    return res.redirect('/forgot-password?error=expired_token');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await userModel.updatePassword(user.id, passwordHash);
  // Revoke every other session — a password change should log out
  // any device the account was compromised on. (No current session exists
  // here since reset flows run while logged out.)
  await userModel.deleteUserSessions(user.id);
  res.redirect('/login?error=password_reset');
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

/** GET /change-password — form for logged-in users. */
async function changePasswordPage(req, res) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  const user = await userModel.findUserById(req.session.userId);
  res.render('change-password', {
    user,
    error: req.query.error || null,
    success: req.query.success === '1'
  });
}

/** POST /change-password — verify current password, then swap in a new one.
 *  Every OTHER session is revoked (the one making the change stays logged in). */
async function changePassword(req, res) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const current = typeof req.body.current_password === 'string' ? req.body.current_password : '';
  const next = typeof req.body.new_password === 'string' ? req.body.new_password : '';

  if (!current || !next) {
    return res.redirect('/change-password?error=missing');
  }
  if (next.length < 8) {
    return res.redirect('/change-password?error=weak');
  }

  const user = await userModel.findUserById(req.session.userId);
  if (!user) {
    req.session.destroy(() => res.redirect('/login'));
    return;
  }

  const currentMatches = await bcrypt.compare(current, user.password_hash);
  if (!currentMatches) {
    return res.redirect('/change-password?error=wrong_current');
  }

  const passwordHash = await bcrypt.hash(next, 10);
  await userModel.updatePassword(user.id, passwordHash);

  // Rotate the session ID (same hardening as login/email-confirm): a stolen
  // pre-change cookie for THIS device also dies. Then kick every other device.
  req.session.regenerate(async (err) => {
    if (err) return res.status(500).send('Something went wrong on our end.');
    req.session.userId = user.id;
    stampSession(req); // regenerate wiped the device metadata — re-record it
    await userModel.deleteUserSessions(user.id, req.sessionID);
    res.redirect('/change-password?success=1');
  });
}

/** GET /security — list the user's active sessions, marking the current device. */
async function securityPage(req, res) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  const user = await userModel.findUserById(req.session.userId);
  const rows = await userModel.listUserSessions(req.session.userId);
  const sessions = rows.map((row) => ({
    sid: row.sid,
    isCurrent: row.sid === req.sessionID,
    device: describeDevice(row.user_agent),
    ip: row.ip || 'unknown',
    signedInAt: row.signed_in_at ? new Date(row.signed_in_at) : null,
    lastActiveAt: row.last_active_at ? new Date(row.last_active_at) : null,
    expiresAt: row.expire ? new Date(row.expire) : null
  }));
  res.render('security', {
    user,
    sessions,
    error: req.query.error || null,
    success: req.query.success === '1'
  });
}

/** POST /security/revoke — delete ONE session (never the current one). */
async function revokeSession(req, res) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  const sid = typeof req.body.sid === 'string' ? req.body.sid.trim() : '';
  if (!sid) {
    return res.redirect('/security?error=missing');
  }
  if (sid === req.sessionID) {
    return res.redirect('/security?error=self');
  }
  await userModel.deleteUserSession(req.session.userId, sid);
  res.redirect('/security?success=1');
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

module.exports = {
  signup, login, dashboard, matchGoal,
  verifyEmailPage, confirmEmail, resendVerification,
  forgotPasswordPage, requestPasswordReset, resetPasswordPage, resetPassword,
  changePasswordPage, changePassword,
  securityPage, revokeSession,
  loginPage, signupPage, logout
};