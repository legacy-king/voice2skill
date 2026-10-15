/**
 * One definition of a student's progress and risk, shared by the tutor roster (/teacher) and the
 * founder admin view (/admin), so both always agree.
 *
 * At risk = has paid access right now AND (no check-in for AT_RISK_DAYS+ days, or never checked in
 * 2+ days after joining). Tutors see it as "needs a nudge".
 */
const { calculateStreak } = require('../utils/streak');

const AT_RISK_DAYS = () => Math.max(1, Number(process.env.AT_RISK_DAYS) || 3);
const PLAN_DAYS = 56;
const DAY_MS = 86400000;

/** Adds paid, daysSince, streak, progressPct, atRisk to a roster row (see cohortModel.getRoster). */
function annotate(row, now = Date.now()) {
  const last = row.last_checkin ? new Date(row.last_checkin).getTime() : null;
  const daysSince = last === null ? null : Math.floor((now - last) / DAY_MS);
  const joinedDays = Math.floor((now - new Date(row.joined_at).getTime()) / DAY_MS);
  const paid = row.status === 'active' && !!row.access_until && new Date(row.access_until).getTime() > now;
  // pg returns DATE columns as local-midnight Dates; calculateStreak reads them as UTC days, so
  // re-anchor to UTC midnight to avoid an off-by-one on servers east of UTC (e.g. Lagos).
  const asUtcDay = (d) => (d instanceof Date ? new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) : new Date(d));
  const streak = calculateStreak((row.recent_dates || []).map((d) => ({ checkin_date: asUtcDay(d) })));
  return {
    ...row,
    paid,
    daysSince,
    streak,
    progressPct: Math.min(100, Math.round((row.checkin_count / PLAN_DAYS) * 100)),
    atRisk: paid && (daysSince === null ? joinedDays >= 2 : daysSince >= AT_RISK_DAYS())
  };
}

module.exports = { annotate, AT_RISK_DAYS };
