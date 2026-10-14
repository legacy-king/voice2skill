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

async function findActiveByCode(code) {
  const { rows } = await pool.query(
    `SELECT c.*, o.name AS org_name
       FROM cohorts c JOIN organizations o ON o.id = c.org_id
      WHERE c.invite_code = $1 AND c.active = TRUE`,
    [code]
  );
  return rows[0];
}

async function getCohort(id) {
  const { rows } = await pool.query(
    `SELECT c.*, o.name AS org_name, o.owner_user_id, o.revenue_share_pct, o.share_basis
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
async function createCohort({ orgId, creatorId, name, priceKobo, accessDays, curriculum, mentorName }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO cohorts (org_id, name, invite_code, price_kobo, access_days, curriculum, mentor_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [orgId, name, generateInviteCode(), priceKobo, accessDays, curriculum, mentorName || null]
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

async function updateCohort(id, { name, priceKobo, accessDays, curriculum, active, mentorName }) {
  // kind = 'bootcamp': the platform's Premium plan is never editable from a teacher page.
  const { rows } = await pool.query(
    `UPDATE cohorts SET name = $2, price_kobo = $3, access_days = $4, curriculum = $5, active = $6,
                        mentor_name = $7
      WHERE id = $1 AND kind = 'bootcamp' RETURNING *`,
    [id, name, priceKobo, accessDays, curriculum, active, mentorName || null]
  );
  return rows[0];
}

/** Cohorts a user can manage (owner of the org, or teacher member), with headline numbers. */
async function listManagedCohorts(userId) {
  const { rows } = await pool.query(
    `SELECT c.*, o.name AS org_name,
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

/** Roster with progress. Deliberately excludes check-in note text (private to the student). */
async function getRoster(cohortId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, m.status, m.access_until, m.joined_at,
            (SELECT COUNT(*) FROM checkins c WHERE c.user_id = u.id)::int AS checkin_count,
            (SELECT MAX(c.checkin_date) FROM checkins c WHERE c.user_id = u.id) AS last_checkin
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
  generateInviteCode, normalizeCode, findActiveByCode, getCohort, getPremiumCohort, getOrgByOwner,
  createCohort, updateCohort, listManagedCohorts, getRoster, getOrgLedger
};
