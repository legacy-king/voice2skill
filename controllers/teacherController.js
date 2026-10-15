const cohortModel = require('../models/cohortModel');
const { loadState, canUse, canManageCohort } = require('../services/entitlements');
const { nairaToKobo } = require('../utils/format');
const { annotate, AT_RISK_DAYS } = require('../services/studentStatus');

const ERRORS = {
  name: 'Give the cohort a name (3–150 characters).',
  price: 'Enter a price in naira between 0 and 1,000,000.',
  days: 'Access days must be a whole number between 1 and 365.',
  curriculum: 'The syllabus is too long (20,000 characters max).',
  mentor_name: 'The mentor name can be at most 80 characters.',
  seats: 'Seats must be a whole number between 1 and 10,000, or blank for no limit.',
  code_expiry: 'Enter the code expiry as a date (YYYY-MM-DD), or leave it blank.',
  no_org: 'Your account is not linked to a bootcamp yet. Contact Voice2Skill.'
};

function parseCohortForm(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const priceKobo = nairaToKobo(body.price);
  const accessDays = Number.parseInt(body.accessDays, 10);
  const curriculum = typeof body.curriculum === 'string' ? body.curriculum.trim() : '';
  // Optional: the name the AI mentor goes by. Blank = the tutor's own account name.
  const mentorName = typeof body.mentorName === 'string' ? body.mentorName.trim() : '';
  // Optional seat limit (blank = unlimited) and invite-code expiry date (blank = never).
  const seatsRaw = typeof body.maxSeats === 'string' ? body.maxSeats.trim() : '';
  const maxSeats = seatsRaw === '' ? null : (/^\d+$/.test(seatsRaw) ? Number(seatsRaw) : NaN);
  const expiryRaw = typeof body.codeExpires === 'string' ? body.codeExpires.trim() : '';
  const codeExpiresAt = expiryRaw === '' ? null : parseExpiryDate(expiryRaw);
  if (name.length < 3 || name.length > 150) return { error: 'name' };
  if (priceKobo === null) return { error: 'price' };
  if (!Number.isInteger(accessDays) || accessDays < 1 || accessDays > 365) return { error: 'days' };
  if (curriculum.length > 20000) return { error: 'curriculum' };
  if (mentorName.length > 80) return { error: 'mentor_name' };
  if (maxSeats !== null && !(Number.isInteger(maxSeats) && maxSeats >= 1 && maxSeats <= 10000)) return { error: 'seats' };
  if (codeExpiresAt === undefined) return { error: 'code_expiry' };
  return { value: { name, priceKobo, accessDays, curriculum, mentorName, maxSeats, codeExpiresAt } };
}

/** "2026-11-30" -> the END of that day in Lagos time (UTC+1, no DST), so the code works all day. */
function parseExpiryDate(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return undefined;
  const [y, mo, day] = m.slice(1).map(Number);
  const check = new Date(Date.UTC(y, mo - 1, day));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== day) return undefined; // e.g. 2026-02-30
  return new Date(`${raw}T23:59:59+01:00`);
}

/** Date input value (YYYY-MM-DD, Lagos time) for a stored expiry. */
function expiryInputValue(date) {
  if (!date) return '';
  return new Date(new Date(date).getTime() + 3600000).toISOString().slice(0, 10);
}

async function requireTeacher(req, res) {
  if (!req.session.userId) { res.redirect('/login'); return null; }
  const state = await loadState(req.session.userId);
  if (!canUse(state, 'teacher_dashboard')) { res.status(404).send('Page not found'); return null; }
  return state;
}

async function teacherHome(req, res) {
  if (!(await requireTeacher(req, res))) return;
  const [cohorts, org] = await Promise.all([
    cohortModel.listManagedCohorts(req.session.userId),
    cohortModel.getOrgByOwner(req.session.userId)
  ]);
  res.render('teacher', {
    cohorts,
    canCreate: !!org,
    error: ERRORS[req.query.error] || null,
    ledger: org ? await cohortModel.getOrgLedger(org.id) : null,
    org
  });
}

async function createCohort(req, res) {
  if (!(await requireTeacher(req, res))) return;
  const org = await cohortModel.getOrgByOwner(req.session.userId);
  if (!org) return res.redirect('/teacher?error=no_org');
  const parsed = parseCohortForm(req.body);
  if (parsed.error) return res.redirect(`/teacher?error=${parsed.error}`);
  const cohort = await cohortModel.createCohort({ orgId: org.id, creatorId: req.session.userId, ...parsed.value });
  req.session.entStale = true;
  res.redirect(`/teacher/cohorts/${cohort.id}?created=1`);
}

async function cohortPage(req, res) {
  if (!(await requireTeacher(req, res))) return;
  const cohortId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(cohortId) || !(await canManageCohort(req.session.userId, cohortId))) {
    return res.status(404).send('Page not found');
  }
  const [cohort, roster] = await Promise.all([cohortModel.getCohort(cohortId), cohortModel.getRoster(cohortId)]);
  const ledger = await cohortModel.getOrgLedger(cohort.org_id);
  const now = Date.now();
  const students = roster.map((s) => annotate(s, now));
  res.render('teacher-cohort', {
    cohort,
    students,
    ledger,
    inviteUrl: `${(process.env.APP_URL || 'https://voice2skill.onrender.com').replace(/\/$/, '')}/join?code=${cohort.invite_code}`,
    created: req.query.created === '1',
    saved: req.query.saved === '1',
    error: ERRORS[req.query.error] || null,
    stuckAfterDays: AT_RISK_DAYS(),
    codeExpiresValue: expiryInputValue(cohort.code_expires_at),
    codeExpired: !!cohort.code_expires_at && new Date(cohort.code_expires_at).getTime() <= now
  });
}

async function updateCohort(req, res) {
  if (!(await requireTeacher(req, res))) return;
  const cohortId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(cohortId) || !(await canManageCohort(req.session.userId, cohortId))) {
    return res.status(404).send('Page not found');
  }
  const parsed = parseCohortForm(req.body);
  if (parsed.error) return res.redirect(`/teacher/cohorts/${cohortId}?error=${parsed.error}`);
  await cohortModel.updateCohort(cohortId, { ...parsed.value, active: req.body.active === 'on' });
  res.redirect(`/teacher/cohorts/${cohortId}?saved=1`);
}

module.exports = { teacherHome, createCohort, cohortPage, updateCohort, parseCohortForm, parseExpiryDate };
