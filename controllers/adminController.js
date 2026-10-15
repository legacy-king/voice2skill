/**
 * Founder admin view (/admin): all bootcamps, cohorts, students, streaks, at-risk students and the
 * revenue share owed to each bootcamp. Read-only (GET only) and invisible to everyone else: a
 * non-admin gets the same 404 as a page that doesn't exist.
 */
const adminModel = require('../models/adminModel');
const cohortModel = require('../models/cohortModel');
const { loadState, canUse } = require('../services/entitlements');
const { annotate, AT_RISK_DAYS } = require('../services/studentStatus');

async function requireAdmin(req, res) {
  if (!req.session.userId) { res.redirect('/login'); return false; }
  const state = await loadState(req.session.userId);
  if (!canUse(state, 'admin_dashboard')) { res.status(404).send('Page not found'); return false; }
  return true;
}

/** Roster summary for one cohort, using the same at-risk rule as the tutor page. */
function summarise(students) {
  const active = students.filter((s) => s.paid);
  return {
    activeStudents: active.length,
    atRisk: students.filter((s) => s.atRisk).length,
    avgStreak: active.length ? Math.round((active.reduce((n, s) => n + s.streak, 0) / active.length) * 10) / 10 : 0
  };
}

async function adminHome(req, res) {
  if (!(await requireAdmin(req, res))) return;
  const [overview, orgs, cohorts] = await Promise.all([
    adminModel.getOverview(), adminModel.listOrgs(), adminModel.listCohorts()
  ]);
  const now = Date.now();
  // Pilot scale (a handful of cohorts): one roster query per cohort keeps a single at-risk rule.
  const withStats = await Promise.all(cohorts.map(async (c) => {
    const students = (await cohortModel.getRoster(c.id)).map((s) => annotate(s, now));
    return { ...c, ...summarise(students), codeExpired: !!c.code_expires_at && new Date(c.code_expires_at).getTime() <= now };
  }));
  res.render('admin', { overview, orgs, cohorts: withStats, atRiskDays: AT_RISK_DAYS() });
}

async function adminCohort(req, res) {
  if (!(await requireAdmin(req, res))) return;
  const cohortId = Number.parseInt(req.params.id, 10);
  const cohort = Number.isInteger(cohortId) ? await cohortModel.getCohort(cohortId) : null;
  if (!cohort) return res.status(404).send('Page not found');
  const now = Date.now();
  const [roster, ledger] = await Promise.all([cohortModel.getRoster(cohortId), cohortModel.getOrgLedger(cohort.org_id)]);
  const students = roster.map((s) => annotate(s, now));
  // At-risk students first, then the least recently active.
  students.sort((a, b) => (b.atRisk - a.atRisk) || ((b.daysSince ?? 1e9) - (a.daysSince ?? 1e9)));
  res.render('admin-cohort', { cohort, students, ledger, summary: summarise(students), atRiskDays: AT_RISK_DAYS() });
}

module.exports = { adminHome, adminCohort };
