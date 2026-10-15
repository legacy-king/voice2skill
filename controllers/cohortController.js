const crypto = require('crypto');
const pool = require('../config/db');
const userModel = require('../models/userModel');
const cohortModel = require('../models/cohortModel');
const paymentModel = require('../models/paymentModel');
const paystack = require('../services/paystack');
const { loadState } = require('../services/entitlements');

const { z } = require('zod');
const { log } = require('../utils/log');

// Paystack webhook payload, as far as settlePayment uses it. Other fields pass through untouched.
const WEBHOOK_EVENT = z.object({
  event: z.string().max(64),
  data: z.object({
    reference: z.string().max(100).optional(),
    status: z.string().max(32).optional(),
    amount: z.number().int().nonnegative().optional(),
    currency: z.string().max(8).optional(),
    fees: z.number().int().nonnegative().nullable().optional()
  }).passthrough().optional()
}).passthrough();

const APP_URL = () => (process.env.APP_URL || 'https://voice2skill.onrender.com').replace(/\/$/, '');

const MESSAGES = {
  already: 'You are already in that cohort.',
  need_access: 'The AI mentor and AI coach come with Premium or a bootcamp cohort. Upgrade below, or enter your tutor\'s cohort code.',
  paid: 'Payment received. Your mentor access is active.',
  premium_unavailable: 'Premium is not available right now. Please try again later.',
  not_paid_yet: 'We have not received your payment yet. If you were charged, it will activate within a few minutes.',
  failed: 'That payment did not go through. You were not charged. Please try again.',
  pay_error: 'We could not start the payment. Please try again in a moment.',
  amount_mismatch: 'We could not confirm that payment automatically. Please do not pay again: we are checking it by hand. Contact support with your Paystack receipt if access is not active within a day.',
  closed: 'That cohort is closed and no longer taking payments. Check with your tutor.',
  now_free: 'Good news: this cohort is now free. Use the Activate button below, no payment needed.'
};
const ERRORS = {
  invalid_code: 'That code was not found, or the cohort is closed. Check it with your tutor.',
  empty_code: 'Enter the cohort code your tutor gave you.',
  cohort_full: 'That cohort is full. Ask your tutor about the next one.',
  expired_code: 'That invite code has expired. Ask your tutor for a new one.'
};
// joinByCode result -> error key on /join
const JOIN_ERRORS = { invalid: 'invalid_code', full: 'cohort_full', expired: 'expired_code' };

/** GET /join — upgrade to Premium, enter a cohort code, see your plans, pay / renew. */
async function joinPage(req, res) {
  if (!req.session.userId) {
    // An invite link opened by someone without an account: sign up with the code filled in.
    const code = cohortModel.normalizeCode(req.query.code);
    return res.redirect(code ? `/signup?code=${code}` : '/login');
  }
  const [state, premium] = await Promise.all([loadState(req.session.userId), cohortModel.getPremiumCohort()]);
  const hasPremiumRow = state.memberships.some((m) => m.kind === 'premium');
  res.render('join', {
    // Once someone has a Premium membership it is listed (and renewed) like any other plan.
    premiumOffer: premium && premium.active && !hasPremiumRow ? premium : null,
    memberships: state.memberships.filter((m) => m.role === 'student'),
    message: MESSAGES[req.query.message] || null,
    error: ERRORS[req.query.error] || null,
    code: typeof req.query.code === 'string' ? req.query.code.slice(0, 12) : ''
  });
}

/** POST /join — redeem an invite code. Creates a pending membership (or activates a free cohort). */
async function joinCohort(req, res) {
  if (!req.session.userId) return res.redirect('/login');
  const code = cohortModel.normalizeCode(req.valid.body.code);
  if (!code) return res.redirect('/join?error=empty_code');

  // Seats, code expiry and the join itself are checked atomically (cohort row lock).
  const { result, free } = await cohortModel.joinByCode(req.session.userId, code);
  if (JOIN_ERRORS[result]) return res.redirect(`/join?error=${JOIN_ERRORS[result]}`);
  req.session.entStale = true;
  if (result === 'already') return res.redirect('/join?message=already');
  res.redirect(free ? '/mentor' : '/join');
}

/** POST /pay/:cohortId — start (or renew) a Paystack checkout. Price comes from the DB, never the client. */
async function startPayment(req, res) {
  if (!req.session.userId) return res.redirect('/login');
  return checkout(req, res, req.valid.params.cohortId);
}

/** Shared by /pay/:cohortId and /premium. cohortId is already a validated integer. */
async function checkout(req, res, cohortId) {

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
    log.error('Payment start failed:', err.message);
    return res.redirect('/join?message=pay_error');
  }
}

/**
 * POST /premium — individual Premium. Premium is a built-in cohort (kind 'premium'), so this only
 * ensures a pending membership and then runs the normal checkout: same price-from-DB rule, same
 * webhook, same idempotent settlePayment(), same 30-day access_until extension.
 */
async function startPremium(req, res) {
  if (!req.session.userId) return res.redirect('/login');
  const premium = await cohortModel.getPremiumCohort();
  if (!premium || !premium.active || premium.price_kobo === 0) return res.redirect('/join?message=premium_unavailable');
  await pool.query(
    `INSERT INTO memberships (user_id, cohort_id, role, status)
     VALUES ($1, $2, 'student', 'pending_payment')
     ON CONFLICT (user_id, cohort_id) DO NOTHING`,
    [req.session.userId, premium.id]
  );
  req.session.entStale = true;
  return checkout(req, res, premium.id);
}

/**
 * GET /pay/callback — where Paystack sends the browser back. Verifies server-side and settles
 * (same idempotent function the webhook uses, so either one alone is enough).
 */
async function paymentCallback(req, res) {
  if (!req.session.userId) return res.redirect('/login');
  const reference = req.valid.query.reference || '';
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
    log.error('Payment callback failed:', err.message);
    return res.redirect('/join?message=not_paid_yet');
  }
}

/** POST /webhooks/paystack — mounted with a RAW body parser, before sessions/CSRF. */
async function paystackWebhook(req, res) {
  let signatureOk = false;
  try {
    signatureOk = paystack.verifySignature(req.body, req.get('x-paystack-signature'));
  } catch (err) {
    log.error('Webhook config error:', err.message);
    return res.sendStatus(500);
  }
  if (!signatureOk) return res.sendStatus(401);

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }
  // Signed, but still validated: only the shape we act on is accepted.
  const parsed = WEBHOOK_EVENT.safeParse(event);
  if (!parsed.success) return res.sendStatus(400);
  event = parsed.data;

  try {
    if (event.event === 'charge.success' && event.data && event.data.reference) {
      const result = await paymentModel.settlePayment(event.data.reference, event.data);
      if (!result.ok && result.reason !== 'unknown_reference') {
        log.warn(`[webhook] ${event.data.reference} not settled: ${result.reason}`);
      }
    }
    return res.sendStatus(200); // ack everything we understood or don't care about
  } catch (err) {
    log.error('Webhook processing failed:', err.message);
    return res.sendStatus(500); // Paystack will retry; settlement is idempotent
  }
}

module.exports = { joinPage, joinCohort, startPayment, startPremium, paymentCallback, paystackWebhook };
