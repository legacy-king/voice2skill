const cohortModel = require('../models/cohortModel');
const { loadState, canUse, canManageCohort } = require('../services/entitlements');
const { nairaToKobo } = require('../utils/format');

const ERRORS = {
  name: 'Give the cohort a name (3–150 characters).',
  price: 'Enter a price in naira between 0 and 1,000,000.',
  days: 'Access days must be a whole number between 1 and 365.',
  curriculum: 'The syllabus is too long (20,000 characters max).',
  mentor_name: 'The mentor name can be at most 80 characters.',
  no_org: 'Your account is not linked to a bootcamp yet. Contact Voice2Skill.'
};
const STUCK_AFTER_DAYS = 3;

function parseCohortForm(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const priceKobo = nairaToKobo(body.price);
  const accessDays = Number.parseInt(body.accessDays, 10);
  const curriculum = typeof body.curriculum === 'string' ? body.curriculum.trim() : '';
  // Optional: the name the AI mentor goes by. Blank = the tutor's own account name.
  const mentorName = typeof body.mentorName === 'string' ? body.mentorName.trim() : '';
  if (name.length < 3 || name.length > 150) return { error: 'name' };
  if (priceKobo === null) return { error: 'price' };
  if (!Number.isInteger(accessDays) || accessDays < 1 || accessDays > 365) return { error: 'days' };
  if (curriculum.length > 20000) return { error: 'curriculum' };
  if (mentorName.length > 80) return { error: 'mentor_name' };
  return { value: { name, priceKobo, accessDays, curriculum, mentorName } };
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
  const students = roster.map((s) => {
    const last = s.last_checkin ? new Date(s.last_checkin).getTime() : null;
    const daysSince = last === null ? null : Math.floor((now - last) / 86400000);
    const joinedDays = Math.floor((now - new Date(s.joined_at).getTime()) / 86400000);
    const paid = s.status === 'active' && s.access_until && new Date(s.access_until).getTime() > now;
    return {
      ...s,
      paid,
      daysSince,
      progressPct: Math.min(100, Math.round((s.checkin_count / 56) * 100)),
      stuck: paid && (daysSince === null ? joinedDays >= 2 : daysSince >= STUCK_AFTER_DAYS)
    };
  });
  res.render('teacher-cohort', {
    cohort,
    students,
    ledger,
    inviteUrl: `${(process.env.APP_URL || 'https://voice2skill.onrender.com').replace(/\/$/, '')}/join?code=${cohort.invite_code}`,
    created: req.query.created === '1',
    saved: req.query.saved === '1',
    error: ERRORS[req.query.error] || null,
    stuckAfterDays: STUCK_AFTER_DAYS
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

module.exports = { teacherHome, createCohort, cohortPage, updateCohort };
