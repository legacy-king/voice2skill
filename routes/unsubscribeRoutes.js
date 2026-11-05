/**
 * Reminder unsubscribe from an email link, without logging in.
 *
 * Mounted in server.js BEFORE sessions (like the Paystack webhook): the signed link (u + HMAC t,
 * utils/unsubscribe.js) is what authenticates the request, so there is no session and no CSRF
 * token, and a visit writes no session row. GET only shows a confirm button, because mail
 * scanners open links on their own; the change is a POST. Mail clients' one-click unsubscribe
 * (RFC 8058) POSTs `List-Unsubscribe=One-Click` to the same URL. Request logs omit the query
 * string, so tokens are never logged.
 */
const express = require('express');
const router = express.Router();
const { rateLimiter } = require('../middleware/security');
const { validate, z, id, hexToken } = require('../middleware/validate');
const { verifyUnsubscribeToken } = require('../utils/unsubscribe');
const accountModel = require('../models/accountModel');

const limiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
const invalid = (req, res) => res.status(400).render('unsubscribe', { state: 'invalid' });
const signedLink = validate({ query: z.object({ u: id(), t: hexToken() }) }, invalid);
const checkSignature = (req, res, next) => (verifyUnsubscribeToken(req.valid.query.u, req.valid.query.t) ? next() : invalid(req, res));

router.get('/unsubscribe', limiter, signedLink, checkSignature, (req, res) => {
  res.render('unsubscribe', { state: 'confirm', u: req.valid.query.u, t: req.valid.query.t });
});

router.post('/unsubscribe', limiter, signedLink, checkSignature, async (req, res) => {
  // A deleted account has nothing to unsubscribe; answer the same way either way.
  await accountModel.setRemindersOptOut(req.valid.query.u, true);
  res.render('unsubscribe', { state: 'done' });
});

module.exports = router;
