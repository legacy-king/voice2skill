const mentorModel = require('../models/mentorModel');
const roadmapModel = require('../models/roadmapModel');
const checkinModel = require('../models/checkinModel');
const { loadState, canUse } = require('../services/entitlements');
const { generateReply, streamReply } = require('../services/mentorService');

const KIND = 'mentor';
// Daily cap per tier (PRD 5.1): bootcamp students 40/day, individual Premium 10/day. Monthly cap is shared.
const DAILY_LIMIT = (m) => (m && m.kind === 'premium'
  ? Number(process.env.PREMIUM_DAILY_LIMIT) || 10
  : Number(process.env.MENTOR_DAILY_LIMIT) || 40);
const MONTHLY_LIMIT = () => Number(process.env.MENTOR_MONTHLY_LIMIT) || 300;
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
    remainingToday: Math.max(0, DAILY_LIMIT(m) - usage.today),
    dailyLimit: DAILY_LIMIT(m),
    kind: m.kind,
    mentorName: m.mentor_name,
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
 * Shared front half of both mentor endpoints: validate, check access, replay, reserve budget,
 * save the user message, build the AI context. Returns either { done: { status, body } } (answer
 * right away with JSON) or { turn } (go ahead and generate).
 */
async function beginTurn(req) {
  const userId = req.session.userId;
  if (!userId) return { done: { status: 401, body: { error: 'login' } } };

  const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
  const clientMsgId = typeof req.body.clientMsgId === 'string' ? req.body.clientMsgId.trim() : '';
  if (!message) return { done: { status: 400, body: { error: 'empty' } } };
  if (message.length > MAX_MESSAGE_CHARS) return { done: { status: 400, body: { error: 'too_long', max: MAX_MESSAGE_CHARS } } };
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientMsgId)) return { done: { status: 400, body: { error: 'bad_client_id' } } };

  const state = await loadState(userId);
  if (!canUse(state, 'mentor_chat')) return { done: { status: 402, body: { error: 'no_access' } } };
  const m = state.mentorMembership;

  let seen = await mentorModel.findByClientMsgId(userId, clientMsgId);
  if (seen && !seen.reply && Date.now() - new Date(seen.created_at).getTime() > STALE_PENDING_MS) {
    // The process died between saving the message and saving the reply. Without this the same id
    // would answer "in progress" forever. Drop the orphan and treat the retry as a fresh attempt.
    await mentorModel.deleteMessage(seen.user_msg_id);
    seen = null;
  }
  if (seen) {
    if (seen.reply) return { done: { status: 200, body: { reply: seen.reply, replayed: true } } };
    return { done: { status: 202, body: { error: 'in_progress' } } };
  }

  // Reserve budget first (atomic) so concurrent requests can't blow past the cap.
  const usedToday = await mentorModel.bumpUsage(userId, KIND);
  const usage = await mentorModel.getUsage(userId, KIND);
  if (usedToday > DAILY_LIMIT(m) || usage.month > MONTHLY_LIMIT()) {
    await mentorModel.refundUsage(userId, KIND);
    return { done: { status: 429, body: { error: usedToday > DAILY_LIMIT(m) ? 'daily_limit' : 'monthly_limit' } } };
  }

  const userMsgId = await mentorModel.insertUserMessage({ userId, cohortId: m.cohort_id, content: message, clientMsgId });
  if (!userMsgId) {
    await mentorModel.refundUsage(userId, KIND); // lost a race with the same clientMsgId
    return { done: { status: 202, body: { error: 'in_progress' } } };
  }

  let ctx;
  try {
    const [history, todayTask] = await Promise.all([
      mentorModel.getHistory(userId, 7),
      currentTaskLine(userId)
    ]);
    // history already contains the just-inserted user message; drop it, it is passed separately.
    const prior = history.filter((h) => h.id !== userMsgId);
    // No student name or email: the model only needs the conversation (PLAN D1).
    ctx = {
      kind: m.kind,
      mentorName: m.mentor_name,
      orgName: m.org_name,
      cohortName: m.cohort_name,
      curriculum: m.curriculum,
      todayTask,
      history: prior,
      message,
      userId
    };
  } catch (err) {
    await undoTurn({ userId, userMsgId });
    throw err;
  }
  return { turn: { userId, m, userMsgId, usedToday, ctx } };
}

/** Undo so the student can retry the same text without losing budget. */
async function undoTurn({ userId, userMsgId }) {
  await mentorModel.deleteMessage(userMsgId).catch(() => {});
  await mentorModel.refundUsage(userId, KIND).catch(() => {});
}

/**
 * POST /mentor/message  { message, clientMsgId }  ->  { reply, remainingToday }
 *
 * Idempotent on (user, clientMsgId): a double-click, a retry after a flaky network, or a replay
 * returns the stored reply and is NOT billed twice.
 */
async function sendMessage(req, res) {
  const { done, turn } = await beginTurn(req);
  if (done) return res.status(done.status).json(done.body);

  try {
    const reply = await generateReply(turn.ctx);
    await mentorModel.insertAssistantMessage({ userId: turn.userId, cohortId: turn.m.cohort_id, content: reply, replyTo: turn.userMsgId });
    return res.json({ reply, remainingToday: Math.max(0, DAILY_LIMIT(turn.m) - turn.usedToday) });
  } catch (err) {
    console.error('Mentor reply failed:', err.message);
    await undoTurn(turn);
    return res.status(502).json({ error: 'ai_unavailable' });
  }
}

/**
 * POST /mentor/message/stream  { message, clientMsgId }
 *
 * Same rules as sendMessage (idempotency, caps, refunds). Errors decided before generation and
 * replays answer with the same JSON as sendMessage. Otherwise the reply streams as server-sent
 * events:  data: {"delta":"..."}  ...  event: done  data: {"remainingToday":n}
 * or, if the AI fails,  event: error  data: {"error":"ai_unavailable"}  (message undone, budget
 * refunded, so the student can retry the same text). If the browser disconnects mid-stream the
 * reply is still finished and saved, so retrying the same clientMsgId replays it.
 */
async function streamMessage(req, res) {
  const { done, turn } = await beginTurn(req);
  if (done) return res.status(done.status).json(done.body);

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive'
  });
  res.flushHeaders();
  let open = true;
  res.on('close', () => { open = false; });
  const send = (event, data) => {
    if (!open) return;
    res.write((event ? 'event: ' + event + '\n' : '') + 'data: ' + JSON.stringify(data) + '\n\n');
  };

  try {
    const reply = await streamReply(turn.ctx, (delta) => send(null, { delta }));
    await mentorModel.insertAssistantMessage({ userId: turn.userId, cohortId: turn.m.cohort_id, content: reply, replyTo: turn.userMsgId });
    send('done', { remainingToday: Math.max(0, DAILY_LIMIT(turn.m) - turn.usedToday) });
  } catch (err) {
    console.error('Mentor stream failed:', err.message);
    await undoTurn(turn);
    send('error', { error: 'ai_unavailable' });
  }
  if (open) res.end();
}

module.exports = { mentorPage, sendMessage, streamMessage, currentTaskLine };
