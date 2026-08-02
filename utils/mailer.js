const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

const APP_URL = process.env.APP_URL || 'https://voice2skill.onrender.com';

// EMAIL_MODE=log prints instead of sending — used by automated tests.
const LOG_ONLY = process.env.EMAIL_MODE === 'log';

/** Escape user-provided text so it can't break email HTML. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendReminderEmail(toEmail, userName) {
  if (LOG_ONLY) {
    console.log(`[mail:log] reminder to ${toEmail}`);
    return;
  }
  await transporter.sendMail({
    from: `"Voice2Skill" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: "Don't break your streak! 🔥",
    html: `
      <p>Hey ${esc(userName)},</p>
      <p>You haven't checked in today on Voice2Skill yet. Even 10 minutes of progress keeps your streak alive.</p>
      <p><a href="${APP_URL}/dashboard">Log in and check in now</a></p>
      <p>— The Voice2Skill Team</p>
    `
  });
}

/** Send the email-verification link with a 24h expiry token. */
async function sendVerificationEmail(toEmail, userName, token) {
  if (LOG_ONLY) {
    console.log(`[mail:log] verify ${toEmail} token=${token}`);
    return;
  }
  const verifyUrl = `${APP_URL}/verify-email/confirm?token=${encodeURIComponent(token)}`;
  await transporter.sendMail({
    from: `"Voice2Skill" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: 'Verify your Voice2Skill email ✉️',
    html: `
      <p>Hi ${esc(userName)},</p>
      <p>Welcome to Voice2Skill! Please confirm your email to activate your account:</p>
      <p style="margin: 24px 0;">
        <a href="${verifyUrl}" style="background:#D4AF37;color:#16130A;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold;">Verify my email</a>
      </p>
      <p style="color:#777;">Or paste this link: <a href="${verifyUrl}">${verifyUrl}</a></p>
      <p style="color:#777;">This link expires in 24 hours. If you didn't sign up for Voice2Skill, you can ignore this email.</p>
      <p>— The Voice2Skill Team</p>
    `
  });
}

/** Send the password-reset link with a 30-minute expiry token. */
async function sendPasswordResetEmail(toEmail, userName, token) {
  if (LOG_ONLY) {
    console.log(`[mail:log] reset ${toEmail} token=${token}`);
    return;
  }
  const resetUrl = `${APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
  await transporter.sendMail({
    from: `"Voice2Skill" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: 'Reset your Voice2Skill password 🔑',
    html: `
      <p>Hi ${esc(userName)},</p>
      <p>We got a request to reset your Voice2Skill password. Click the button below to set a new one:</p>
      <p style="margin: 24px 0;">
        <a href="${resetUrl}" style="background:#D4AF37;color:#16130A;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold;">Reset my password</a>
      </p>
      <p style="color:#777;">Or paste this link: <a href="${resetUrl}">${resetUrl}</a></p>
      <p style="color:#777;">This link expires in 30 minutes. If you didn't request this, you can safely ignore this email — your password won't change.</p>
      <p>— The Voice2Skill Team</p>
    `
  });
}

/** Alert the account owner when a sign-in looks like a new device. */
async function sendNewDeviceAlertEmail(toEmail, userName, deviceLabel, ip) {
  if (LOG_ONLY) {
    console.log(`[mail:log] newdevice ${toEmail} device=${deviceLabel} ip=${ip}`);
    return;
  }
  await transporter.sendMail({
    from: `"Voice2Skill" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: 'New device signed in to your Voice2Skill account 🛡️',
    html: `
      <p>Hey ${esc(userName)},</p>
      <p>We noticed a sign-in to your Voice2Skill account from a device we haven't seen before:</p>
      <p style="background:#1C1C1C;border:1px solid #2A2A2A;border-radius:8px;padding:14px 18px;">
        <b>Device:</b> ${esc(deviceLabel)}<br>
        <b>IP:</b> ${esc(ip)}<br>
        <b>Time:</b> ${new Date().toLocaleString()}
      </p>
      <p>Was this you? No action needed. If it wasn't, <a href="${APP_URL}/security">review your active sessions</a> and consider <a href="${APP_URL}/change-password">changing your password</a>.</p>
      <p>— The Voice2Skill Team</p>
    `
  });
}

/** Alert the account owner when one of their sessions is revoked. */
async function sendSessionRevokedEmail(toEmail, userName, deviceLabel, ip) {
  if (LOG_ONLY) {
    console.log(`[mail:log] revoke ${toEmail} device=${deviceLabel} ip=${ip}`);
    return;
  }
  await transporter.sendMail({
    from: `"Voice2Skill" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: 'A device was signed out of your Voice2Skill account',
    html: `
      <p>Hey ${esc(userName)},</p>
      <p>A device was just signed out of your Voice2Skill account:</p>
      <p style="background:#1C1C1C;border:1px solid #2A2A2A;border-radius:8px;padding:14px 18px;">
        <b>Device:</b> ${esc(deviceLabel)}<br>
        <b>IP:</b> ${esc(ip)}<br>
        <b>Time:</b> ${new Date().toLocaleString()}
      </p>
      <p>If this was you, no action needed. If you didn't revoke it, <a href="${APP_URL}/security">check your sessions</a> and <a href="${APP_URL}/change-password">change your password</a> right away.</p>
      <p>— The Voice2Skill Team</p>
    `
  });
}

module.exports = { sendReminderEmail, sendVerificationEmail, sendPasswordResetEmail, sendNewDeviceAlertEmail, sendSessionRevokedEmail };