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

/** Update a user's password, record when, and clear any reset/verification tokens. */
async function updatePassword(userId, passwordHash) {
  const result = await pool.query(
    `UPDATE users
     SET password_hash = $1,
         password_reset_token = NULL,
         password_reset_token_expires = NULL,
         password_changed_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [passwordHash, userId]
  );
  return result.rows[0];
}

/**
 * Delete all session rows belonging to a user (e.g. after a password change,
 * to revoke every other logged-in session). `exceptSid` keeps the current
 * session when one exists.
 */
async function deleteUserSessions(userId, exceptSid = null) {
  const params = [String(userId)];
  let query = `DELETE FROM "session" WHERE sess::jsonb ->> 'userId' = $1`;
  if (exceptSid) {
    params.push(String(exceptSid));
    query += ` AND sid <> $2`;
  }
  const result = await pool.query(query, params);
  return result.rowCount;
}

/** List every active session belonging to a user (for the security page). */
async function listUserSessions(userId) {
  const result = await pool.query(
    `SELECT sid, expire,
            sess::jsonb ->> 'userAgent' AS user_agent,
            sess::jsonb ->> 'ip' AS ip,
            sess::jsonb ->> 'signedInAt' AS signed_in_at,
            sess::jsonb ->> 'lastActiveAt' AS last_active_at
     FROM "session"
     WHERE sess::jsonb ->> 'userId' = $1
     ORDER BY expire DESC`,
    [String(userId)]
  );
  return result.rows;
}

/** Get ONE session row, only if it belongs to the user (ownership check).
 *  Used to capture device info before a revoke wipes the row. */
async function getUserSession(userId, sid) {
  const result = await pool.query(
    `SELECT sid, expire,
            sess::jsonb ->> 'userAgent' AS user_agent,
            sess::jsonb ->> 'ip' AS ip
     FROM "session"
     WHERE sid = $1 AND sess::jsonb ->> 'userId' = $2`,
    [String(sid), String(userId)]
  );
  return result.rows[0] || null;
}

/** Delete ONE session, only if it belongs to the user (ownership check). */
async function deleteUserSession(userId, sid) {
  const result = await pool.query(
    `DELETE FROM "session"
     WHERE sid = $1 AND sess::jsonb ->> 'userId' = $2`,
    [String(sid), String(userId)]
  );
  return result.rowCount;
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
  updatePassword,
  deleteUserSessions,
  listUserSessions,
  getUserSession,
  deleteUserSession
};
