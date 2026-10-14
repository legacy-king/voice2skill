const crypto = require('crypto');
const pool = require('../config/db');
const userModel = require('../models/userModel');
const cohortModel = require('../models/cohortModel');
const paymentModel = require('../models/paymentModel');
const paystack = require('../utils/paystack');
const { loadState } = require('../utils/entitlements');

const APP_URL = () => (process.env.APP_URL || 'https://voice2skill.onrender.com').replace(/\/$/, '');

const MESSAGES = {
  already: 'You are already in that cohort.',
  need_access: 'The AI mentor is part of a bootcamp cohort. Enter your cohort code to unlock it.',
  paid: 'Payment received. Your mentor access is active.',
  not_paid_yet: 'We have not received your payment yet. If you were charged, it will activate within a few minutes.',
  failed: 'That payment did not go through. You were not charged. Please try again.',
  pay_error: 'We could not start the payment. Please try again in a moment.',
  amount_mismatch: 'We could not confirm that payment automatically. Please do not pay again: we are checking it by hand. Contact support with your Paystack receipt if access is not active within a day.',
  closed: 'That cohort is closed and no longer taking payments. Check with your tutor.',
  now_free: 'Good news: this cohort is now free. Use the Activate button below, no payment needed.'
};
const ERRORS = {
  invalid_code: 'That code was not found, or the cohort is closed. Check it with your tutor.',
  empty_code: 'Enter the cohort code your tutor gave you.'
};

/** GET /join — enter a code, see your cohorts, pay / renew. */
async function joinPage(req, res) {
  if (!req.session.userId) return res.redirect('/login');
  const state = await loadState(req.session.userId);
  res.render('join', {
    memberships: state.memberships.filter((m) => m.role === 'student'),
    message: MESSAGES[req.query.message] || null,
    error: ERRORS[req.query.error] || null,
    code: typeof req.query.code === 'string' ? req.query.code.slice(0, 12) : ''
  });
}

/** POST /join — redeem an invite code. Creates a pending membership (or activates a free cohort). */
async function joinCohort(req, res) {
  if (!req.session.userId) return res.redirect('/login');
  const raw = typeof req.body.code === 'string' ? req.body.code : '';
  const code = cohortModel.normalizeCode(raw);
  if (!code) return res.redirect('/join?error=empty_code');

  const cohort = await cohortModel.findActiveByCode(code);
  if (!cohort) return res.redirect('/join?error=invalid_code');

  const free = cohort.price_kobo === 0;
  const until = free ? new Date(Date.now() + cohort.access_days * 86400000) : null;
  // Paid cohort: create a pending membership (no-op if one exists).
  // Free cohort: also (re)activate a pending or expired membership, so free access can be renewed
  // and a cohort the tutor later switched from paid to free doesn't strand people.
  const onConflict = free
    ? `DO UPDATE SET status = 'active', access_until = $4
         WHERE memberships.role = 'student'
           AND (memberships.status <> 'active' OR memberships.access_until IS NULL OR memberships.access_until < NOW())`
    : 'DO NOTHING';
  const { rowCount } = await pool.query(
    `INSERT INTO memberships (user_id, cohort_id, role, status, access_until)
     VALUES ($1, $2, 'student', $3, $4)
     ON CONFLICT (user_id, cohort_id) ${onConflict}`,
    [req.session.userId, cohort.id, free ? 'active' : 'pending_payment', until]
  );
  req.session.entStale = true;
  if (rowCount === 0) return res.redirect('/join?message=already');
  res.redirect(free ? '/mentor' : '/join');
}

/** POST /pay/:cohortId — start (or renew) a Paystack checkout. Price comes from the DB, never the client. */
async function startPayment(req, res) {
  if (!req.session.userId) return res.redirect('/login');
  const cohortId = Number.parseInt(req.params.cohortId, 10);
  if (!Number.isInteger(cohortId)) return res.status(404).send('Cohort not found');

  const userId = req.session.userId;
  const cohort = await cohortModel.getCohort(cohortId);
  const { rows } = await pool.query(
    "SELECT access_until FROM memberships WHERE user_id = $1 AND cohort_id = $2 AND role = 'student'",
    [userId, cohortId]
  );
  if (!cohort || rows.length === 0) {
    return res.status(404).send('Cohort not found');
  }
  // The join page may be stale: the tutor can close the cohort or make it free after it loaded.
  // A closed cohort takes no first payments; students who have had access may still renew.
  const neverActivated = rows[0].access_until === null;
  if (!cohort.active && neverActivated) return res.redirect('/join?message=closed');
  if (cohort.price_kobo === 0) return res.redirect('/join?message=now_free');

  const user = await userModel.findUserById(userId);
  const reference = `v2s_${cohortId}_${userId}_${crypto.randomBytes(8).toString('hex')}`;
  try {
    await paymentModel.createPending({
      userId, cohortId, orgId: cohort.org_id, reference, amountKobo: cohort.price_kobo
    });
    const init = await paystack.initialize({
      email: user.email,
      amountKobo: cohort.price_kobo,
      reference,
      callbackUrl: `${APP_URL()}/pay/callback`,
      metadata: { user_id: userId, cohort_id: cohortId }
    });
    return res.redirect(init.authorization_url);
  } catch (err) {
    console.error('Payment start failed:', err.message);
    return res.redirect('/join?message=pay_error');
  }
}

/**
 * GET /pay/callback — where Paystack sends the browser back. Verifies server-side and settles
 * (same idempotent function the webhook uses, so either one alone is enough).
 */
async function paymentCallback(req, res) {
  if (!req.session.userId) return res.redirect('/login');
  const reference = typeof req.query.reference === 'string' ? req.query.reference.slice(0, 100) : '';
  const payment = reference ? await paymentModel.getByReference(reference) : null;
  if (!payment || payment.user_id !== req.session.userId) return res.redirect('/join');

  try {
    const data = await paystack.verify(reference);
    const result = await paymentModel.settlePayment(reference, data);
    req.session.entStale = true;
    if (result.ok) return res.redirect('/mentor?paid=1');
    const reason = ['failed', 'amount_mismatch'].includes(result.reason) ? result.reason : 'not_paid_yet';
    return res.redirect(`/join?message=${reason}`);
  } catch (err) {
    console.error('Payment callback failed:', err.message);
    return res.redirect('/join?message=not_paid_yet');
  }
}

/** POST /webhooks/paystack — mounted with a RAW body parser, before sessions/CSRF. */
async function paystackWebhook(req, res) {
  let signatureOk = false;
  try {
    signatureOk = paystack.verifySignature(req.body, req.get('x-paystack-signature'));
  } catch (err) {
    console.error('Webhook config error:', err.message);
    return res.sendStatus(500);
  }
  if (!signatureOk) return res.sendStatus(401);

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }

  try {
    if (event.event === 'charge.success' && event.data && event.data.reference) {
      const result = await paymentModel.settlePayment(event.data.reference, event.data);
      if (!result.ok && result.reason !== 'unknown_reference') {
        console.warn(`[webhook] ${event.data.reference} not settled: ${result.reason}`);
      }
    }
    return res.sendStatus(200); // ack everything we understood or don't care about
  } catch (err) {
    console.error('Webhook processing failed:', err.message);
    return res.sendStatus(500); // Paystack will retry; settlement is idempotent
  }
}

module.exports = { joinPage, joinCohort, startPayment, paymentCallback, paystackWebhook };
