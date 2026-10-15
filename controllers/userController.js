const crypto = require('crypto');
const bcrypt = require('bcrypt');
const userModel = require('../models/userModel');
const cohortModel = require('../models/cohortModel');
const roadmapModel = require('../models/roadmapModel');
const trackModel = require('../models/trackModel');
const { sendVerificationEmail, sendPasswordResetEmail, sendNewDeviceAlertEmail, sendSessionRevokedEmail } = require('../services/mailer');
const { rankTracksForGoal } = require('../utils/goalMatcher');

const { EMAIL_RE } = require('../middleware/validate');
// bcrypt work factor: at least 12 (PLAN Phase 6). Older cost-10 hashes are upgraded on next login.
const BCRYPT_COST = Math.max(12, Number(process.env.BCRYPT_COST) || 12);
const { log } = require('../utils/log');
const GLYPHS = ['</>', '✦', '∑', '◎', '⚿'];
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESET_TTL_MS = 30 * 60 * 1000; // 30 min
// Compared against when no account exists, so a wrong email takes as long as a
// wrong password and the response can't reveal which accounts exist.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

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

/**
 * If this sign-in comes from a device the account hasn't seen before, email the
 * owner. Never blocks login — failures are logged and swallowed. Compares the
 * current request's (user-agent, IP) against every EXISTING session's metadata
 * (the fresh session isn't persisted yet when this runs).
 */
async function maybeAlertNewDevice(user, req) {
  try {
    const ua = String(req.headers['user-agent'] || '').slice(0, 200);
    const ip = req.ip || 'unknown';
    const sessions = await userModel.listUserSessions(user.id);
    if (sessions.length === 0) return; // first-ever sign-in — nothing to compare
    const seenBefore = sessions.some((s) => s.user_agent === ua && s.ip === ip);
    if (!seenBefore) {
      await sendNewDeviceAlertEmail(user.email, user.name, describeDevice(ua), ip);
    }
  } catch (err) {
    log.error('New-device alert failed:', err.message);
  }
}

// Bootcamp code problems at signup -> signup page error key.
const SIGNUP_CODE_ERRORS = { invalid: 'code_invalid', full: 'code_full', expired: 'code_expired' };

async function signup(req, res) {
  const { name, email, password } = req.valid.body;
  // Optional bootcamp invite code. Checked now for quick feedback; the seat is only taken when the
  // email is verified (confirmEmail), so unverified sign-ups can't fill a cohort.
  const code = cohortModel.normalizeCode(req.valid.body.code);
  const back = (error) => res.redirect(`/signup?error=${error}${code ? `&code=${code}` : ''}`);

  if (!name || name.length > 100) {
    return back('name');
  }
  if (!EMAIL_RE.test(email) || email.length > 150) {
    return back('email');
  }
  if (password.length < 8) {
    return back('password');
  }
  let signupCohortId = null;
  if (code) {
    const { cohort, reason } = await cohortModel.checkCode(code);
    if (reason) return back(SIGNUP_CODE_ERRORS[reason]);
    signupCohortId = cohort.id;
  }

  const existingUser = await userModel.findUserByEmail(email);
  if (existingUser && existingUser.email_verified) {
    return back('taken');
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + VERIFY_TTL_MS);

  let userId;
  if (existingUser) {
    await userModel.setVerificationToken(existingUser.id, token, expiresAt);
    userId = existingUser.id;
  } else {
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    userId = (await userModel.createUser(name, email, passwordHash, token, expiresAt)).id;
  }
  if (signupCohortId) await userModel.setSignupCohort(userId, signupCohortId);

  // Fire the email in the background — don't make the user wait on it.
  sendVerificationEmail(email, name, token).catch(err => {
    log.error('Failed to send verification email:', err.message);
  });

  // Do NOT auto-login — require verification first.
  res.redirect('/verify-email?sent=1');
}

async function login(req, res) {
  const { email, password } = req.valid.body;

  if (!email || !password) {
    return res.redirect('/login?error=missing');
  }

  const existingUser = await userModel.findUserByEmail(email);
  const passwordMatches = await bcrypt.compare(password, existingUser ? existingUser.password_hash : DUMMY_PASSWORD_HASH);
  // Same message for unknown email and wrong password — don't reveal who has an account.
  if (!existingUser || !passwordMatches) {
    return res.redirect('/login?error=invalid_credentials');
  }

  if (!existingUser.email_verified) {
    return res.redirect('/login?error=not_verified');
  }

  // Correct password: doesn't count against the per-email login limit.
  res.locals.loginOk = true;

  // Transparent upgrade of older, cheaper hashes (we only have the plain password right now).
  if (bcrypt.getRounds(existingUser.password_hash) < BCRYPT_COST) {
    try {
      await userModel.setPasswordHash(existingUser.id, await bcrypt.hash(password, BCRYPT_COST));
    } catch (err) {
      log.error('Password rehash failed:', err.message);
    }
  }

  // Alert the owner if this looks like a device the account hasn't seen before.
  // Runs before regenerate() so it compares against EXISTING sessions only.
  // Fire-and-forget: never blocks or breaks the login.
  maybeAlertNewDevice(existingUser, req);

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
  const { token } = req.valid.query;
  if (!token) {
    return res.redirect('/verify-email?error=invalid');
  }

  const user = await userModel.findUserByVerificationToken(token);
  if (!user) {
    return res.redirect('/verify-email?error=invalid');
  }

  await userModel.markEmailVerified(user.id);

  // Signed up with a bootcamp code: join that cohort now (seat + expiry checked under a lock).
  let next = '/dashboard';
  if (user.signup_cohort_id) {
    const cohort = await cohortModel.getCohort(user.signup_cohort_id);
    const joined = cohort ? await cohortModel.joinByCode(user.id, cohort.invite_code) : { result: 'invalid' };
    if (joined.result === 'joined') next = joined.free ? '/mentor' : '/join';
    else if (joined.result === 'full') next = '/join?error=cohort_full';
    else if (joined.result === 'expired') next = '/join?error=expired_code';
    else if (joined.result === 'invalid') next = '/join?error=invalid_code';
  }

  // Alert the owner if this confirmation comes from a new device.
  maybeAlertNewDevice(user, req);

  // New session on privilege elevation (prevents session fixation).
  req.session.regenerate((err) => {
    if (err) return res.status(500).send('Something went wrong on our end.');
    req.session.userId = user.id;
    stampSession(req);
    res.redirect(next);
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
  const { email } = req.valid.body;
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
      log.error('Failed to send password reset email:', err.message);
      return res.redirect('/forgot-password?error=send_failed');
    }
  }

  res.redirect('/forgot-password?sent=1');
}

/** GET /reset-password?token=... — show the new-password form. */
async function resetPasswordPage(req, res) {
  const { token } = req.valid.query;
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
  const { token, password } = req.valid.body;

  if (password.length < 8) {
    return res.redirect(`/reset-password?token=${encodeURIComponent(token)}&error=weak`);
  }

  const user = await userModel.findUserByPasswordResetToken(token);
  if (!user) {
    return res.redirect('/forgot-password?error=expired_token');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  await userModel.updatePassword(user.id, passwordHash);
  // Revoke every other session — a password change should log out
  // any device the account was compromised on. (No current session exists
  // here since reset flows run while logged out.)
  await userModel.deleteUserSessions(user.id);
  res.redirect('/login?error=password_reset');
}

/** POST /verify-email/resend — regenerates the token and re-sends. */
async function resendVerification(req, res) {
  const { email } = req.valid.body;
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
      log.error('Failed to resend verification email:', err.message);
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

  const { current_password: current, new_password: next } = req.valid.body;

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

  const passwordHash = await bcrypt.hash(next, BCRYPT_COST);
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
  const { sid } = req.valid.body;
  if (!sid) {
    return res.redirect('/security?error=missing');
  }
  if (sid === req.sessionID) {
    return res.redirect('/security?error=self');
  }
  // Capture the device label BEFORE deleting the row so the alert can say
  // exactly which device was kicked. Fire-and-forget: revoking never fails
  // because an email alert did.
  const target = await userModel.getUserSession(req.session.userId, sid);
  await userModel.deleteUserSession(req.session.userId, sid);
  if (target) {
    const user = await userModel.findUserById(req.session.userId);
    sendSessionRevokedEmail(
      user.email,
      user.name,
      describeDevice(target.user_agent),
      target.ip || 'unknown'
    ).catch((err) => log.error('Revoked-session alert failed:', err.message));
  }
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

  const { goal } = req.valid.body;
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
  res.render('signup', {
    error: typeof req.query.error === 'string' ? req.query.error : null,
    code: cohortModel.normalizeCode(req.query.code)
  });
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