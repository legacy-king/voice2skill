const mentorModel = require('../models/mentorModel');
const roadmapModel = require('../models/roadmapModel');
const checkinModel = require('../models/checkinModel');
const userModel = require('../models/userModel');
const { loadState, canUse } = require('../utils/entitlements');
const { generateReply } = require('../utils/mentorService');

const KIND = 'mentor';
const DAILY_LIMIT = () => Number(process.env.MENTOR_DAILY_LIMIT) || 40;
const MONTHLY_LIMIT = () => Number(process.env.MENTOR_MONTHLY_LIMIT) || 600;
const MAX_MESSAGE_CHARS = 1000;
const STALE_PENDING_MS = 60 * 1000;

async function mentorPage(req, res) {
  if (!req.session.userId) return res.redirect('/login');
  const state = await loadState(req.session.userId);
  if (!canUse(state, 'mentor_chat')) return res.redirect('/join?message=need_access');

  const m = state.mentorMembership;
  const [history, usage] = await Promise.all([
    mentorModel.getHistory(req.session.userId),
    mentorModel.getUsage(req.session.userId, KIND)
  ]);
  res.render('mentor', {
    cohortName: m.cohort_name,
    orgName: m.org_name,
    accessUntil: m.role === 'teacher' ? null : m.access_until,
    history,
    remainingToday: Math.max(0, DAILY_LIMIT() - usage.today),
    dailyLimit: DAILY_LIMIT(),
    justPaid: req.query.paid === '1'
  });
}

/** The student's current roadmap task, as one line of grounding context (best effort). */
async function currentTaskLine(userId) {
  try {
    const roadmap = await roadmapModel.getRoadmapByUser(userId);
    if (!roadmap) return null;
    const checkins = await checkinModel.getCheckinsByRoadmap(userId, roadmap.id);
    const days = roadmap.content.weeks.flatMap((w) => w.days.map((d) => ({ ...d, focus: w.focus })));
    const today = days[checkins.length];
    return today ? `${today.focus} — ${today.task}`.slice(0, 300) : null;
  } catch {
    return null;
  }
}

/**
 * POST /mentor/message  { message, clientMsgId }  ->  { reply, remainingToday }
 *
 * Idempotent on (user, clientMsgId): a double-click, a retry after a flaky network, or a replay
 * returns the stored reply and is NOT billed twice.
 */
async function sendMessage(req, res) {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: 'login' });

  const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
  const clientMsgId = typeof req.body.clientMsgId === 'string' ? req.body.clientMsgId.trim() : '';
  if (!message) return res.status(400).json({ error: 'empty' });
  if (message.length > MAX_MESSAGE_CHARS) return res.status(400).json({ error: 'too_long', max: MAX_MESSAGE_CHARS });
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientMsgId)) return res.status(400).json({ error: 'bad_client_id' });

  const state = await loadState(userId);
  if (!canUse(state, 'mentor_chat')) return res.status(402).json({ error: 'no_access' });
  const m = state.mentorMembership;

  let seen = await mentorModel.findByClientMsgId(userId, clientMsgId);
  if (seen && !seen.reply && Date.now() - new Date(seen.created_at).getTime() > STALE_PENDING_MS) {
    // The process died between saving the message and saving the reply. Without this the same id
    // would answer "in progress" forever. Drop the orphan and treat the retry as a fresh attempt.
    await mentorModel.deleteMessage(seen.user_msg_id);
    seen = null;
  }
  if (seen) {
    if (seen.reply) return res.json({ reply: seen.reply, replayed: true });
    return res.status(202).json({ error: 'in_progress' });
  }

  // Reserve budget first (atomic) so concurrent requests can't blow past the cap.
  const usedToday = await mentorModel.bumpUsage(userId, KIND);
  const usage = await mentorModel.getUsage(userId, KIND);
  if (usedToday > DAILY_LIMIT() || usage.month > MONTHLY_LIMIT()) {
    await mentorModel.refundUsage(userId, KIND);
    return res.status(429).json({ error: usedToday > DAILY_LIMIT() ? 'daily_limit' : 'monthly_limit' });
  }

  const userMsgId = await mentorModel.insertUserMessage({ userId, cohortId: m.cohort_id, content: message, clientMsgId });
  if (!userMsgId) {
    await mentorModel.refundUsage(userId, KIND); // lost a race with the same clientMsgId
    return res.status(202).json({ error: 'in_progress' });
  }

  try {
    const [history, user, todayTask] = await Promise.all([
      mentorModel.getHistory(userId, 7),
      userModel.findUserById(userId),
      currentTaskLine(userId)
    ]);
    // history already contains the just-inserted user message; drop it, it is passed separately.
    const prior = history.filter((h) => h.id !== userMsgId);

    const reply = await generateReply({
      orgName: m.org_name,
      cohortName: m.cohort_name,
      studentName: user.name,
      curriculum: m.curriculum,
      todayTask,
      history: prior,
      message
    });
    await mentorModel.insertAssistantMessage({ userId, cohortId: m.cohort_id, content: reply, replyTo: userMsgId });
    return res.json({ reply, remainingToday: Math.max(0, DAILY_LIMIT() - usedToday) });
  } catch (err) {
    console.error('Mentor reply failed:', err.message);
    // Undo so the student can retry the same text without losing budget.
    await mentorModel.deleteMessage(userMsgId).catch(() => {});
    await mentorModel.refundUsage(userId, KIND).catch(() => {});
    return res.status(502).json({ error: 'ai_unavailable' });
  }
}

module.exports = { mentorPage, sendMessage };
