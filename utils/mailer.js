const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

async function sendReminderEmail(toEmail, userName) {
  await transporter.sendMail({
    from: `"Voice2Skill" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: "Don't break your streak! 🔥",
    html: `
      <p>Hey ${userName},</p>
      <p>You haven't checked in today on Voice2Skill yet. Even 10 minutes of progress keeps your streak alive.</p>
      <p><a href="https://voice2skill.onrender.com/dashboard">Log in and check in now</a></p>
      <p>— The Voice2Skill Team</p>
    `
  });
}

module.exports = { sendReminderEmail };