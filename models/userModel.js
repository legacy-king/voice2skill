const crypto = require('crypto');
const pool = require('../config/db');

/** SHA-256 hash of a verification token — only the hash is stored/looked up,
 *  so a DB leak doesn't expose usable tokens. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createUser(name, email, passwordHash, verificationToken, verificationTokenExpires) {
  const result = await pool.query(
    `INSERT INTO users (name, email, password_hash, verification_token, verification_token_expires)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name, email, passwordHash, hashToken(verificationToken), verificationTokenExpires]
  );
  return result.rows[0];
}

async function findUserByEmail(email) {
    const result = await pool.query(
        'SELECT * FROM users WHERE email = $1',
        [email]
    );
    return result.rows[0];
}
async function findUserById(id) {
    const result = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [id]
    )
    return result.rows[0];
}

/** Find a user by an unexpired verification token. */
async function findUserByVerificationToken(token) {
  const result = await pool.query(
    'SELECT * FROM users WHERE verification_token = $1 AND verification_token_expires > NOW()',
    [hashToken(token)]
  );
  return result.rows[0];
}

/** Mark a user verified and clear the token. */
async function markEmailVerified(userId) {
  const result = await pool.query(
    `UPDATE users
     SET email_verified = TRUE, verification_token = NULL, verification_token_expires = NULL
     WHERE id = $1
     RETURNING *`,
    [userId]
  );
  return result.rows[0];
}

/** Replace the verification token (for resend flows). */
async function setVerificationToken(userId, token, expiresAt) {
  const result = await pool.query(
    'UPDATE users SET verification_token = $1, verification_token_expires = $2 WHERE id = $3 RETURNING *',
    [hashToken(token), expiresAt, userId]
  );
  return result.rows[0];
}

/** Store a hashed password-reset token with expiry. */
async function setPasswordResetToken(userId, token, expiresAt) {
  const result = await pool.query(
    'UPDATE users SET password_reset_token = $1, password_reset_token_expires = $2 WHERE id = $3 RETURNING *',
    [hashToken(token), expiresAt, userId]
  );
  return result.rows[0];
}

/** Find a user by an unexpired password-reset token. */
async function findUserByPasswordResetToken(token) {
  const result = await pool.query(
    'SELECT * FROM users WHERE password_reset_token = $1 AND password_reset_token_expires > NOW()',
    [hashToken(token)]
  );
  return result.rows[0];
}

/** Update a user's password and clear any reset/verification tokens. */
async function updatePassword(userId, passwordHash) {
  const result = await pool.query(
    `UPDATE users
     SET password_hash = $1,
         password_reset_token = NULL,
         password_reset_token_expires = NULL
     WHERE id = $2
     RETURNING *`,
    [passwordHash, userId]
  );
  return result.rows[0];
}

module.exports = {
  createUser,
  findUserByEmail,
  findUserById,
  findUserByVerificationToken,
  markEmailVerified,
  setVerificationToken,
  setPasswordResetToken,
  findUserByPasswordResetToken,
  updatePassword
};
