const crypto = require('crypto');
const pool = require('../config/db');

// No 0/O/1/I/L — codes get read aloud and typed from WhatsApp screenshots.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateInviteCode(length = 8) {
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Strip spaces/dashes, uppercase. "kj7m-q2xd" -> "KJ7MQ2XD". */
function normalizeCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

const SEATS_TAKEN_SQL = `(SELECT COUNT(*) FROM memberships sm
   WHERE sm.cohort_id = c.id AND sm.role = 'student' AND sm.status <> 'cancelled')::int`;

/** Why a code can't take a NEW student right now, or null if it can. (Existing members bypass this.) */
function closedReason(cohort, seatsTaken, now = Date.now()) {
  if (!cohort || !cohort.active) return 'invalid';
  if (cohort.code_expires_at && new Date(cohort.code_expires_at).getTime() <= now) return 'expired';
  if (cohort.max_seats && seatsTaken >= cohort.max_seats) return 'full';
  return null;
}

/** Read-only check used for early feedback (signup form). joinByCode re-checks under a lock. */
async function checkCode(code) {
  const { rows } = await pool.query(
    `SELECT c.*, o.name AS org_name, ${SEATS_TAKEN_SQL} AS seats_taken
       FROM cohorts c JOIN organizations o ON o.id = c.org_id
      WHERE c.invite_code = $1`,
    [code]
  );
  const cohort = rows[0];
  return { cohort, reason: closedReason(cohort, cohort ? cohort.seats_taken : 0) };
}

/**
 * Redeem an invite code for a user, atomically. The cohort row is locked (FOR UPDATE) so two
 * students racing for the last seat can't both get it. A paid cohort creates a pending membership;
 * a free one activates (or renews) access. Existing members are never blocked by seats or expiry.
 * -> { result: 'joined' | 'already' | 'invalid' | 'expired' | 'full', cohort, free }
 */
async function joinByCode(userId, code) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT c.*, o.name AS org_name FROM cohorts c JOIN organizations o ON o.id = c.org_id
        WHERE c.invite_code = $1 FOR UPDATE OF c`,
      [code]
    );
    const cohort = rows[0];
    if (!cohort || !cohort.active) { await client.query('ROLLBACK'); return { result: 'invalid' }; }

    const existing = await client.query('SELECT 1 FROM memberships WHERE user_id = $1 AND cohort_id = $2', [userId, cohort.id]);
    if (existing.rowCount === 0) {
      const taken = await client.query(
        "SELECT COUNT(*)::int AS n FROM memberships WHERE cohort_id = $1 AND role = 'student' AND status <> 'cancelled'",
        [cohort.id]
      );
      const reason = closedReason(cohort, taken.rows[0].n);
      if (reason) { await client.query('ROLLBACK'); return { result: reason, cohort }; }
    }

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
    const ins = await client.query(
      `INSERT INTO memberships (user_id, cohort_id, role, status, access_until)
       VALUES ($1, $2, 'student', $3, $4)
       ON CONFLICT (user_id, cohort_id) ${onConflict}`,
      [userId, cohort.id, free ? 'active' : 'pending_payment', until]
    );
    await client.query('COMMIT');
    return { result: ins.rowCount ? 'joined' : 'already', cohort, free };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getCohort(id) {
  const { rows } = await pool.query(
    `SELECT c.*, o.name AS org_name, o.owner_user_id, o.revenue_share_pct, o.share_basis,
            ${SEATS_TAKEN_SQL} AS seats_taken
       FROM cohorts c JOIN organizations o ON o.id = c.org_id WHERE c.id = $1`,
    [id]
  );
  return rows[0];
}

/** The built-in individual Premium plan (seeded by db/cohorts.sql). */
async function getPremiumCohort() {
  const { rows } = await pool.query("SELECT * FROM cohorts WHERE kind = 'premium' LIMIT 1");
  return rows[0];
}

async function getOrgByOwner(userId) {
  const { rows } = await pool.query('SELECT * FROM organizations WHERE owner_user_id = $1 ORDER BY id LIMIT 1', [userId]);
  return rows[0];
}

/** Create a cohort (retrying on the astronomically unlikely code collision) + teacher membership for the creator. */
async function createCohort({ orgId, creatorId, name, priceKobo, accessDays, curriculum, mentorName, maxSeats = null, codeExpiresAt = null }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO cohorts (org_id, name, invite_code, price_kobo, access_days, curriculum, mentor_name, max_seats, code_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [orgId, name, generateInviteCode(), priceKobo, accessDays, curriculum, mentorName || null, maxSeats, codeExpiresAt]
      );
      await client.query(
        `INSERT INTO memberships (user_id, cohort_id, role, status)
         VALUES ($1, $2, 'teacher', 'active') ON CONFLICT (user_id, cohort_id) DO NOTHING`,
        [creatorId, rows[0].id]
      );
      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505' && /invite_code/.test(err.detail || err.constraint || '')) continue;
      throw err;
    } finally {
      client.release();
    }
  }
  throw new Error('Could not generate a unique invite code');
}

async function updateCohort(id, { name, priceKobo, accessDays, curriculum, active, mentorName, maxSeats = null, codeExpiresAt = null }) {
  // kind = 'bootcamp': the platform's Premium plan is never editable from a teacher page.
  const { rows } = await pool.query(
    `UPDATE cohorts SET name = $2, price_kobo = $3, access_days = $4, curriculum = $5, active = $6,
                        mentor_name = $7, max_seats = $8, code_expires_at = $9
      WHERE id = $1 AND kind = 'bootcamp' RETURNING *`,
    [id, name, priceKobo, accessDays, curriculum, active, mentorName || null, maxSeats, codeExpiresAt]
  );
  return rows[0];
}

/** Cohorts a user can manage (owner of the org, or teacher member), with headline numbers. */
async function listManagedCohorts(userId) {
  const { rows } = await pool.query(
    `SELECT c.*, o.name AS org_name, ${SEATS_TAKEN_SQL} AS seats_taken,
            (SELECT COUNT(*) FROM memberships m WHERE m.cohort_id = c.id AND m.role = 'student')::int AS students,
            (SELECT COUNT(*) FROM memberships m WHERE m.cohort_id = c.id AND m.role = 'student'
                AND m.status = 'active' AND m.access_until > NOW())::int AS active_students
       FROM cohorts c JOIN organizations o ON o.id = c.org_id
      WHERE o.owner_user_id = $1
         OR EXISTS (SELECT 1 FROM memberships t WHERE t.cohort_id = c.id AND t.user_id = $1 AND t.role = 'teacher')
      ORDER BY c.created_at DESC`,
    [userId]
  );
  return rows;
}

/**
 * Roster with progress. Deliberately excludes check-in note text (private to the student).
 * recent_dates (last 60 days of check-in dates) is only used to compute the streak.
 */
async function getRoster(cohortId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, m.status, m.access_until, m.joined_at,
            (SELECT COUNT(*) FROM checkins c WHERE c.user_id = u.id)::int AS checkin_count,
            (SELECT MAX(c.checkin_date) FROM checkins c WHERE c.user_id = u.id) AS last_checkin,
            ARRAY(SELECT DISTINCT c.checkin_date FROM checkins c
                   WHERE c.user_id = u.id AND c.checkin_date >= CURRENT_DATE - 60) AS recent_dates
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.cohort_id = $1 AND m.role = 'student'
      ORDER BY last_checkin ASC NULLS FIRST, m.joined_at ASC`,
    [cohortId]
  );
  return rows;
}

/** Money summary for an org (all its cohorts): collected, bootcamp's share, paid out, still owed. */
async function getOrgLedger(orgId) {
  const pay = await pool.query(
    `SELECT COALESCE(SUM(amount_kobo), 0)::bigint AS gross,
            COALESCE(SUM(provider_fee_kobo), 0)::bigint AS fees,
            COALESCE(SUM(org_share_kobo), 0)::bigint AS org_share,
            COUNT(*)::int AS payments
       FROM payments WHERE org_id = $1 AND status = 'success'`,
    [orgId]
  );
  const out = await pool.query(
    'SELECT COALESCE(SUM(amount_kobo), 0)::bigint AS paid_out FROM org_payouts WHERE org_id = $1',
    [orgId]
  );
  const g = pay.rows[0];
  const paidOut = Number(out.rows[0].paid_out);
  return {
    gross: Number(g.gross),
    fees: Number(g.fees),
    orgShare: Number(g.org_share),
    payments: g.payments,
    paidOut,
    owed: Number(g.org_share) - paidOut
  };
}

module.exports = {
  generateInviteCode, normalizeCode, checkCode, joinByCode, closedReason, SEATS_TAKEN_SQL, getCohort, getPremiumCohort, getOrgByOwner,
  createCohort, updateCohort, listManagedCohorts, getRoster, getOrgLedger
};
