/**
 * Single source of truth for "what can this user do?".
 * Controllers call canUse(state, feature) — never scatter `if (paid)` checks.
 *
 * Tiers (PRD §5.1):
 *   Free     — structured plan pointing to free resources, check-ins, streaks, reminders. No AI
 *              coaching or mentor; voice input (speech-to-text) is allowed, with a smaller cap.
 *   Premium  — individual, paid (a built-in cohort of kind 'premium'): AI coach + AI mentor.
 *   Bootcamp — a tutor's cohort (paid, or free if the tutor sets ₦0): AI coach + an AI mentor that
 *              carries the tutor's name and answers from the tutor's syllabus.
 */
const pool = require('../config/db');

/** Everything we need to decide access, from one query. */
async function loadState(userId) {
  const { rows } = await pool.query(
    `SELECT m.id AS membership_id, m.cohort_id, m.role, m.status, m.access_until,
            c.name AS cohort_name, c.kind, c.price_kobo, c.access_days, c.active, c.curriculum, c.invite_code,
            COALESCE(NULLIF(TRIM(c.mentor_name), ''), u.name, o.name) AS mentor_name,
            o.id AS org_id, o.name AS org_name, o.owner_user_id
       FROM memberships m
       JOIN cohorts c ON c.id = m.cohort_id
       JOIN organizations o ON o.id = c.org_id
       LEFT JOIN users u ON u.id = o.owner_user_id
      WHERE m.user_id = $1
      ORDER BY m.joined_at DESC`,
    [userId]
  );
  const owned = await pool.query('SELECT 1 FROM organizations WHERE owner_user_id = $1 LIMIT 1', [userId]);
  const admin = await pool.query('SELECT is_admin FROM users WHERE id = $1', [userId]);
  const now = Date.now();

  const grantsAccess = (r) => {
    // NB: cohort.active only gates NEW joins; already-paid students keep what they paid for.
    if (r.status !== 'active') return false;
    if (r.role === 'teacher') return true;
    return r.access_until && new Date(r.access_until).getTime() > now;
  };
  const activeRows = rows.filter(grantsAccess);
  // The mentor uses one membership: a bootcamp (tutor's syllabus) beats Premium, then the one
  // that lasts longest (teachers have no expiry => treated as far future).
  const expiry = (r) => (r.role === 'teacher' ? Infinity : new Date(r.access_until).getTime());
  activeRows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'bootcamp' ? -1 : 1;
    return expiry(b) - expiry(a);
  });

  return {
    memberships: rows,
    mentorMembership: activeRows[0] || null,
    hasPremium: activeRows.some((r) => r.kind === 'premium'),
    hasCohort: activeRows.some((r) => r.kind === 'bootcamp'),
    isTeacher: owned.rowCount > 0 || rows.some((r) => r.role === 'teacher'),
    isAdmin: !!(admin.rows[0] && admin.rows[0].is_admin)
  };
}

function canUse(state, feature) {
  switch (feature) {
    // Every AI feature is paid: Premium or an active bootcamp membership.
    case 'mentor_chat':
    case 'ai_coach':
      return !!state.mentorMembership;
    // Voice input is the product's name: every signed-in user gets it (PLAN D2). The daily cap
    // differs by tier (controllers/voiceController.js).
    case 'voice_stt':
      return true;
    case 'teacher_dashboard': return !!state.isTeacher;
    // Founder view across every bootcamp: read-only, users.is_admin only.
    case 'admin_dashboard': return !!state.isAdmin;
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
