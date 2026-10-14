/**
 * Single source of truth for "what can this user do?".
 * Controllers call canUse(state, feature) — never scatter `if (paid)` checks.
 */
const pool = require('../config/db');

/** Everything we need to decide access, from one query. */
async function loadState(userId) {
  const { rows } = await pool.query(
    `SELECT m.id AS membership_id, m.cohort_id, m.role, m.status, m.access_until,
            c.name AS cohort_name, c.price_kobo, c.access_days, c.active, c.curriculum, c.invite_code,
            o.id AS org_id, o.name AS org_name, o.owner_user_id
       FROM memberships m
       JOIN cohorts c ON c.id = m.cohort_id
       JOIN organizations o ON o.id = c.org_id
      WHERE m.user_id = $1
      ORDER BY m.joined_at DESC`,
    [userId]
  );
  const owned = await pool.query('SELECT 1 FROM organizations WHERE owner_user_id = $1 LIMIT 1', [userId]);
  const now = Date.now();

  const grantsMentor = (r) => {
    // NB: cohort.active only gates NEW joins; already-paid students keep what they paid for.
    if (r.status !== 'active') return false;
    if (r.role === 'teacher') return true;
    return r.access_until && new Date(r.access_until).getTime() > now;
  };
  const mentorRows = rows.filter(grantsMentor);
  // Prefer the membership that lasts longest (teachers have no expiry => treated as far future).
  mentorRows.sort((a, b) => {
    const ta = a.role === 'teacher' ? Infinity : new Date(a.access_until).getTime();
    const tb = b.role === 'teacher' ? Infinity : new Date(b.access_until).getTime();
    return tb - ta;
  });

  return {
    memberships: rows,
    mentorMembership: mentorRows[0] || null,
    isTeacher: owned.rowCount > 0 || rows.some((r) => r.role === 'teacher')
  };
}

function canUse(state, feature) {
  switch (feature) {
    case 'mentor_chat': return !!state.mentorMembership;
    case 'teacher_dashboard': return !!state.isTeacher;
    default: return false;
  }
}

/** Can this user manage (view roster/edit) the given cohort? Org owner or teacher member. */
async function canManageCohort(userId, cohortId) {
  const { rowCount } = await pool.query(
    `SELECT 1
       FROM cohorts c
       JOIN organizations o ON o.id = c.org_id
      WHERE c.id = $1
        AND (o.owner_user_id = $2
             OR EXISTS (SELECT 1 FROM memberships m
                         WHERE m.cohort_id = c.id AND m.user_id = $2 AND m.role = 'teacher'))`,
    [cohortId, userId]
  );
  return rowCount > 0;
}

module.exports = { loadState, canUse, canManageCohort };
