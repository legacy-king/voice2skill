#!/usr/bin/env node
/**
 * SIT — System Integration Test for the full auth journey.
 *
 * Boots the real Express server against the configured database and walks:
 *   signup → blocked-login (unverified) → verify → login → logout →
 *   forgot password → reset → session revocation → login with new password
 *   → goal matching → CSRF rejection
 *
 * Emails are logged (EMAIL_MODE=log), never sent. Creates ONE test user and
 * cleans it up (user, sessions, roadmaps, check-ins) when done.
 *
 * Requires DATABASE_URL in .env. Usage:
 *   EMAIL_MODE=log node scripts/sit-test.js
 */
process.env.EMAIL_MODE = 'log'; // never send real emails during tests
process.env.PORT = process.env.PORT || '3210';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const TEST_EMAIL = `sit-${Date.now()}@voice2skill.test`;
const OLD_PASSWORD = 'old-password-123';
const NEW_PASSWORD = 'new-password-456';
const FINAL_PASSWORD = 'final-password-789';

// ---- Capture mailer log output so we can read the tokens it "sent" ----
const logLines = [];
const origLog = console.log;
console.log = (...args) => {
  logLines.push(args.join(' '));
  origLog(...args);
};

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`✓ ${name}`);
  } else {
    failures += 1;
    console.error(`✗ ${name} ${detail}`);
  }
}

function tokenFromLog(kind) {
  for (let i = logLines.length - 1; i >= 0; i--) {
    const m = logLines[i].match(new RegExp(`\\[mail:log\\] ${kind} [^ ]+ token=([0-9a-f]{64})`));
    if (m) return m[1];
  }
  return null;
}

function csrfFrom(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  return m ? m[1] : null;
}

// ---- Minimal cookie jars (fetch with redirect: 'manual') ----
// One jar per simulated device so we can prove cross-device session revocation.
const jar = new Map();
const jar2 = new Map();
function cookieHeader(j = jar) {
  return [...j.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function saveCookies(res, j = jar) {
  const setCookies = (res.headers.getSetCookie && res.headers.getSetCookie()) || [];
  for (const sc of setCookies) {
    const pair = sc.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) j.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

async function req(path, { method = 'GET', form, jar: useJar = jar, userAgent } = {}) {
  const headers = { cookie: cookieHeader(useJar) };
  if (userAgent) headers['user-agent'] = userAgent;
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body, redirect: 'manual' });
  saveCookies(res, useJar);
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), text };
}

// A genuinely different device (e.g. someone's phone) so the new-device alert fires.
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
function hasMailLog(kind) {
  return logLines.some((l) => l.includes(`[mail:log] ${kind} ${TEST_EMAIL}`));
}

async function main() {
  // Boot the real server in-process.
  require('../server');

  // Give the listener a moment.
  await new Promise((r) => setTimeout(r, 400));

  console.log(`\n=== SIT: auth journey (test user ${TEST_EMAIL}) ===\n`);

  // 1. Public pages load
  for (const [label, path] of [['login', '/login'], ['signup', '/signup'], ['forgot', '/forgot-password'], ['verify page', '/verify-email']]) {
    const res = await req(path);
    check(`${label} page loads`, res.status === 200);
  }

  // 1b. SEO endpoints
  const sitemap = await req('/sitemap.xml');
  check('sitemap.xml serves XML with the index URL', sitemap.status === 200 && sitemap.text.includes('<urlset') && sitemap.text.includes('<loc>'), sitemap.status);
  const robots = await req('/robots.txt');
  check('robots.txt serves crawl rules', robots.status === 200 && robots.text.includes('User-agent: *') && robots.text.includes('Sitemap:'), robots.status);

  // 2. CSRF required on POST
  const noCsrf = await req('/login', { method: 'POST', form: { email: TEST_EMAIL, password: OLD_PASSWORD } });
  check('POST without CSRF token is rejected', noCsrf.status === 403);

  // 3. Signup (valid)
  const signupPage = await req('/signup');
  const signupCsrf = csrfFrom(signupPage.text);
  const signup = await req('/signup', {
    method: 'POST',
    form: { _csrf: signupCsrf, name: 'SIT User', email: TEST_EMAIL, password: OLD_PASSWORD }
  });
  check('signup redirects to verify-email', signup.status === 302 && (signup.location || '').startsWith('/verify-email?sent=1'), signup.location);
  check('verification email logged', tokenFromLog('verify') !== null);

  // 4. Login blocked while unverified
  const loginPage = await req('/login');
  const loginCsrf = csrfFrom(loginPage.text);
  const blocked = await req('/login', {
    method: 'POST',
    form: { _csrf: loginCsrf, email: TEST_EMAIL, password: OLD_PASSWORD }
  });
  check('login blocked for unverified user', blocked.status === 302 && (blocked.location || '').includes('not_verified'), blocked.location);

  // 5. Verify email → logged in
  const verifyToken = tokenFromLog('verify');
  const confirm = await req(`/verify-email/confirm?token=${verifyToken}`);
  check('confirm redirects to dashboard', confirm.status === 302 && (confirm.location || '') === '/dashboard', confirm.location);
  const dash = await req('/dashboard');
  check('dashboard loads after verify', dash.status === 200 && dash.text.includes('SIT User'));

  // 6. Logout (POST)
  const dash2 = await req('/dashboard');
  const logoutCsrf = csrfFrom(dash2.text);
  const logout = await req('/logout', { method: 'POST', form: { _csrf: logoutCsrf } });
  const afterLogout = await req('/dashboard');
  check('logout clears session', logout.status === 302 && afterLogout.status === 302 && (afterLogout.location || '').includes('/login'), afterLogout.location);

  // 7. Login with valid credentials
  const loginPage2 = await req('/login');
  const loginCsrf2 = csrfFrom(loginPage2.text);
  const login = await req('/login', {
    method: 'POST',
    form: { _csrf: loginCsrf2, email: TEST_EMAIL, password: OLD_PASSWORD }
  });
  check('login succeeds after verify', login.status === 302 && (login.location || '') === '/dashboard', login.location);

  // 8. Goal matching (no Gemini call — just the confirm page)
  const dash3 = await req('/dashboard');
  const goalCsrf = csrfFrom(dash3.text);
  const goal = await req('/dashboard/goal', {
    method: 'POST',
    form: { _csrf: goalCsrf, goal: 'design a mobile app interface' }
  });
  check('goal matching renders confirm page', goal.status === 200 && goal.text.includes('UI/UX Design') && goal.text.includes('Not quite it?'));
  check('goal-confirm POST forms carry CSRF', /action="\/tracks\/\d+\/select"/.test(goal.text));

  // 9. Forgot password → reset token logged
  const forgotPage = await req('/forgot-password');
  const forgotCsrf = csrfFrom(forgotPage.text);
  const forgot = await req('/forgot-password', {
    method: 'POST',
    form: { _csrf: forgotCsrf, email: TEST_EMAIL }
  });
  check('forgot-password redirects to sent', forgot.status === 302 && (forgot.location || '').startsWith('/forgot-password?sent=1'), forgot.location);
  const resetToken = tokenFromLog('reset');
  check('reset email logged', resetToken !== null);

  // 10. Reset page validates token, then resets password
  const resetPage = await req(`/reset-password?token=${resetToken}`);
  check('reset page renders for valid token', resetPage.status === 200 && resetPage.text.includes('Set a new password'));
  const resetCsrf = csrfFrom(resetPage.text);
  const weak = await req('/reset-password', {
    method: 'POST',
    form: { _csrf: resetCsrf, token: resetToken, password: 'short' }
  });
  check('weak password rejected', weak.status === 302 && (weak.location || '').includes('error=weak'), weak.location);
  const reset = await req('/reset-password', {
    method: 'POST',
    form: { _csrf: resetCsrf, token: resetToken, password: NEW_PASSWORD }
  });
  check('password reset succeeds', reset.status === 302 && (reset.location || '').includes('password_reset'), reset.location);

  // 11. Session revocation: the pre-reset session must be dead
  const afterReset = await req('/dashboard');
  check('pre-reset session revoked', afterReset.status === 302 && (afterReset.location || '').includes('/login'), afterReset.location);

  // 12. Login with the NEW password works; old password fails
  const loginPage3 = await req('/login');
  const loginCsrf3 = csrfFrom(loginPage3.text);
  const oldLogin = await req('/login', {
    method: 'POST',
    form: { _csrf: loginCsrf3, email: TEST_EMAIL, password: OLD_PASSWORD }
  });
  check('old password rejected', oldLogin.status === 302 && (oldLogin.location || '').includes('wrong_password'), oldLogin.location);
  const loginPage4 = await req('/login');
  const loginCsrf4 = csrfFrom(loginPage4.text);
  const newLogin = await req('/login', {
    method: 'POST',
    form: { _csrf: loginCsrf4, email: TEST_EMAIL, password: NEW_PASSWORD }
  });
  check('new password logs in', newLogin.status === 302 && (newLogin.location || '') === '/dashboard', newLogin.location);

  // 13. Change password while logged in — current session survives, others don't
  const changePage = await req('/change-password');
  check('change-password page loads when logged in', changePage.status === 200 && changePage.text.includes('Change password'), changePage.status);
  const changeCsrf = csrfFrom(changePage.text);
  const wrongCurrent = await req('/change-password', {
    method: 'POST',
    form: { _csrf: changeCsrf, current_password: 'not-the-password', new_password: FINAL_PASSWORD }
  });
  check('wrong current password rejected', wrongCurrent.status === 302 && (wrongCurrent.location || '').includes('wrong_current'), wrongCurrent.location);

  const changePage2 = await req('/change-password');
  const changeCsrf2 = csrfFrom(changePage2.text);
  const changed = await req('/change-password', {
    method: 'POST',
    form: { _csrf: changeCsrf2, current_password: NEW_PASSWORD, new_password: FINAL_PASSWORD }
  });
  check('change-password succeeds', changed.status === 302 && (changed.location || '').includes('success=1'), changed.location);
  const afterChange = await req('/dashboard');
  check('current session survives password change', afterChange.status === 200 && afterChange.text.includes('SIT User'), afterChange.status);

  // 14. Old (pre-change) password no longer works; the new one does
  const loginPage5 = await req('/login');
  const loginCsrf5 = csrfFrom(loginPage5.text);
  const preChangeLogin = await req('/login', {
    method: 'POST',
    form: { _csrf: loginCsrf5, email: TEST_EMAIL, password: NEW_PASSWORD }
  });
  check('pre-change password rejected after change', preChangeLogin.status === 302 && (preChangeLogin.location || '').includes('wrong_password'), preChangeLogin.location);
  const loginPage6 = await req('/login');
  const loginCsrf6 = csrfFrom(loginPage6.text);
  const finalLogin = await req('/login', {
    method: 'POST',
    form: { _csrf: loginCsrf6, email: TEST_EMAIL, password: FINAL_PASSWORD }
  });
  check('changed password logs in', finalLogin.status === 302 && (finalLogin.location || '') === '/dashboard', finalLogin.location);

  // 15. Security page: lists sessions, marks the current device, and revokes a second one
  const secPage = await req('/security');
  check('security page loads', secPage.status === 200 && secPage.text.includes('Active sessions'), secPage.status);
  check('security page marks current device', secPage.text.includes('This device'));
  check('security page marks current device active now', secPage.text.includes('Active now'), 'missing Active now marker');
  const secPageLate = await req('/security');
  check('security page shows last-active for other devices', secPageLate.text.includes('Last active'), 'missing Last active marker');

  // Sign in from a SECOND device (separate cookie jar + different user-agent)
  const loginPage7 = await req('/login', { jar: jar2 });
  const loginCsrf7 = csrfFrom(loginPage7.text);
  const login2 = await req('/login', {
    jar: jar2,
    userAgent: PHONE_UA,
    method: 'POST',
    form: { _csrf: loginCsrf7, email: TEST_EMAIL, password: FINAL_PASSWORD }
  });
  check('second device logs in', login2.status === 302 && (login2.location || '') === '/dashboard', login2.location);
  const dashB = await req('/dashboard', { jar: jar2 });
  check('second device sees dashboard', dashB.status === 200 && dashB.text.includes('SIT User'), dashB.status);
  check('new-device alert email logged', hasMailLog('newdevice'), 'no [mail:log] newdevice line');

  // Device A now sees both sessions on the security page
  const secPage2 = await req('/security');
  const sidCount = (secPage2.text.match(/name="sid" value="/g) || []).length;
  check('security page lists revocable sessions', sidCount >= 1, `found ${sidCount} revocable sid(s)`);

  // Device B's sid = the revocable sid on the page (the current one has no revoke form)
  const otherSid = (secPage2.text.match(/name="sid" value="([^"]+)"/) || [])[1];
  const secCsrf = csrfFrom(secPage2.text);
  const revoked = await req('/security/revoke', {
    method: 'POST',
    form: { _csrf: secCsrf, sid: otherSid }
  });
  check('revoke succeeds', revoked.status === 302 && (revoked.location || '').includes('success=1'), revoked.location);
  check('revoked-session alert email logged', hasMailLog('revoke'), 'no [mail:log] revoke line');

  // Device B is now dead; Device A is untouched
  const dashB2 = await req('/dashboard', { jar: jar2 });
  check('revoked device is signed out', dashB2.status === 302 && (dashB2.location || '').includes('/login'), dashB2.location);
  const dashA = await req('/dashboard');
  check('current device still signed in', dashA.status === 200 && dashA.text.includes('SIT User'), dashA.status);

  // Self-revoke must be blocked
  const secPage3 = await req('/security');
  const secCsrf3 = csrfFrom(secPage3.text);
  const mySid = decodeURIComponent(jar.get('voice2skill.sid') || '').split('.')[0].replace(/^s:/, '');
  const selfRevoke = await req('/security/revoke', {
    method: 'POST',
    form: { _csrf: secCsrf3, sid: mySid }
  });
  check('self-revoke blocked', selfRevoke.status === 302 && (selfRevoke.location || '').includes('error=self'), selfRevoke.location);
  const dashA2 = await req('/dashboard');
  check('current device survives self-revoke attempt', dashA2.status === 200 && dashA2.text.includes('SIT User'), dashA2.status);

  // ---- Cleanup ----
  const pool = require('../config/db');
  await pool.query('DELETE FROM checkins WHERE user_id = (SELECT id FROM users WHERE email = $1)', [TEST_EMAIL]);
  await pool.query('DELETE FROM roadmaps WHERE user_id = (SELECT id FROM users WHERE email = $1)', [TEST_EMAIL]);
  await pool.query('DELETE FROM "session" WHERE sess::jsonb ->> \'userId\' = (SELECT id::text FROM users WHERE email = $1)', [TEST_EMAIL]);
  await pool.query('DELETE FROM users WHERE email = $1', [TEST_EMAIL]);
  await pool.end();

  console.log('');
  if (failures > 0) {
    console.error(`SIT FAILED — ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('SIT passed — full auth journey OK.');
  process.exit(0);
}

main().catch((err) => {
  console.error('SIT crashed:', err);
  process.exit(1);
});
