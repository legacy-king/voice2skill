/**
 * Founder admin view (read-only): every bootcamp, cohort and payment total in one place.
 * Like the tutor roster, nothing here selects check-in note text or mentor chats.
 */
const pool = require('../config/db');
const { SEATS_TAKEN_SQL } = require('./cohortModel');

/** Headline numbers. Money in kobo. */
async function getOverview() {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM users)::int AS users,
       (SELECT COUNT(*) FROM users WHERE email_verified)::int AS verified_users,
       (SELECT COUNT(DISTINCT user_id) FROM memberships
         WHERE role = 'student' AND status = 'active' AND access_until > NOW())::int AS paying_students,
       (SELECT COUNT(DISTINCT user_id) FROM checkins WHERE checkin_date >= CURRENT_DATE - 6)::int AS active_7d,
       (SELECT COALESCE(SUM(amount_kobo), 0) FROM payments WHERE status = 'success')::bigint AS gross,
       (SELECT COALESCE(SUM(provider_fee_kobo), 0) FROM payments WHERE status = 'success')::bigint AS fees,
       (SELECT COALESCE(SUM(org_share_kobo), 0) FROM payments WHERE status = 'success')::bigint AS org_share,
       (SELECT COALESCE(SUM(amount_kobo), 0) FROM org_payouts)::bigint AS paid_out`
  );
  const r = rows[0];
  const gross = Number(r.gross), fees = Number(r.fees), orgShare = Number(r.org_share), paidOut = Number(r.paid_out);
  return {
    users: r.users,
    verifiedUsers: r.verified_users,
    payingStudents: r.paying_students,
    active7d: r.active_7d,
    gross,
    fees,
    orgShare,
    platformNet: gross - fees - orgShare,
    paidOut,
    owed: orgShare - paidOut
  };
}

/**
 * Is anyone learning? Counts, not percentages, so the page shows "x of y".
 *   activation: signed up 2-30 days ago -> checked in within 48 h of signing up
 *   week 2:     plan started 14-60 days ago -> a check-in on days 8-14 of the plan
 *   join->paid: joined a paid plan in the last 30 days -> has a successful payment for it
 *   AI:         router calls this month (llm_calls; tokens, not money: prices vary by model)
 */
async function getFunnel() {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '7 days')::int AS signups7d,
       (SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '30 days')::int AS signups30d,
       (SELECT COUNT(*) FROM users u WHERE u.created_at BETWEEN NOW() - INTERVAL '30 days' AND NOW() - INTERVAL '2 days')::int AS "activationBase",
       (SELECT COUNT(*) FROM users u WHERE u.created_at BETWEEN NOW() - INTERVAL '30 days' AND NOW() - INTERVAL '2 days'
          AND EXISTS (SELECT 1 FROM checkins c WHERE c.user_id = u.id AND c.created_at <= u.created_at + INTERVAL '48 hours'))::int AS activated,
       (SELECT COUNT(*) FROM roadmaps r WHERE r.created_at BETWEEN NOW() - INTERVAL '60 days' AND NOW() - INTERVAL '14 days')::int AS "week2Base",
       (SELECT COUNT(*) FROM roadmaps r WHERE r.created_at BETWEEN NOW() - INTERVAL '60 days' AND NOW() - INTERVAL '14 days'
          AND EXISTS (SELECT 1 FROM checkins c WHERE c.roadmap_id = r.id
                       AND c.checkin_date BETWEEN r.created_at::date + 7 AND r.created_at::date + 13))::int AS "week2Active",
       (SELECT COUNT(*) FROM memberships m JOIN cohorts c ON c.id = m.cohort_id
         WHERE m.role = 'student' AND c.price_kobo > 0 AND m.joined_at >= NOW() - INTERVAL '30 days')::int AS "joinsBase",
       (SELECT COUNT(*) FROM memberships m JOIN cohorts c ON c.id = m.cohort_id
         WHERE m.role = 'student' AND c.price_kobo > 0 AND m.joined_at >= NOW() - INTERVAL '30 days'
           AND EXISTS (SELECT 1 FROM payments p WHERE p.user_id = m.user_id AND p.cohort_id = m.cohort_id AND p.status = 'success'))::int AS "joinsPaid",
       (SELECT COUNT(*) FROM llm_calls WHERE created_at >= date_trunc('month', NOW()))::int AS "aiCalls",
       (SELECT COUNT(*) FROM llm_calls WHERE created_at >= date_trunc('month', NOW()) AND NOT ok)::int AS "aiFailed",
       (SELECT COALESCE(SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0)
          FROM llm_calls WHERE created_at >= date_trunc('month', NOW()))::bigint AS "aiTokens"`
  );
  return { ...rows[0], aiTokens: Number(rows[0].aiTokens) };
}

/** Every organization with its revenue share and what is still owed to it. */
async function listOrgs() {
  const { rows } = await pool.query(
    `SELECT o.id, o.name, o.revenue_share_pct, o.share_basis, u.name AS owner_name, u.email AS owner_email,
            (SELECT COUNT(*) FROM cohorts c WHERE c.org_id = o.id)::int AS cohorts,
            COALESCE(p.gross, 0)::bigint AS gross,
            COALESCE(p.org_share, 0)::bigint AS org_share,
            COALESCE(p.payments, 0)::int AS payments,
            COALESCE(po.paid_out, 0)::bigint AS paid_out
       FROM organizations o
       LEFT JOIN users u ON u.id = o.owner_user_id
       LEFT JOIN (SELECT org_id, SUM(amount_kobo) AS gross, SUM(org_share_kobo) AS org_share, COUNT(*) AS payments
                    FROM payments WHERE status = 'success' GROUP BY org_id) p ON p.org_id = o.id
       LEFT JOIN (SELECT org_id, SUM(amount_kobo) AS paid_out FROM org_payouts GROUP BY org_id) po ON po.org_id = o.id
      ORDER BY o.name`
  );
  return rows.map((r) => ({
    ...r,
    gross: Number(r.gross),
    orgShare: Number(r.org_share),
    paidOut: Number(r.paid_out),
    owed: Number(r.org_share) - Number(r.paid_out)
  }));
}

/** Every cohort (bootcamp and Premium) with seats and member counts. */
async function listCohorts() {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.kind, c.invite_code, c.price_kobo, c.access_days, c.active, c.max_seats,
            c.code_expires_at, c.created_at, o.name AS org_name,
            ${SEATS_TAKEN_SQL} AS seats_taken
       FROM cohorts c JOIN organizations o ON o.id = c.org_id
      ORDER BY c.kind = 'premium', c.created_at DESC`
  );
  return rows;
}

module.exports = { getOverview, getFunnel, listOrgs, listCohorts };
