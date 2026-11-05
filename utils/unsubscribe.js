/**
 * Signed one-click unsubscribe links for reminder emails. The link carries the user id and an
 * HMAC of it, so it works without logging in and can't be forged for someone else. No DB column:
 * the token is derived from SESSION_SECRET with its own label (rotating that secret retires old
 * links, which only means an old email's link stops working; the Security page toggle remains).
 */
const crypto = require('crypto');

const APP_URL = () => (process.env.APP_URL || 'https://voice2skill.onrender.com').replace(/\/$/, '');
const key = () => process.env.SESSION_SECRET || 'insecure-dev-secret-change-me';

function unsubscribeToken(userId) {
  return crypto.createHmac('sha256', key()).update(`unsubscribe-reminders:${Number(userId)}`).digest('hex');
}

function verifyUnsubscribeToken(userId, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
  const a = Buffer.from(unsubscribeToken(userId));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function unsubscribeUrl(userId) {
  return `${APP_URL()}/unsubscribe?u=${Number(userId)}&t=${unsubscribeToken(userId)}`;
}

module.exports = { unsubscribeToken, verifyUnsubscribeToken, unsubscribeUrl };
