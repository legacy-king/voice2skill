const checkinModel = require('../models/checkinModel');
const roadmapModel = require('../models/roadmapModel');
const coachResponseModel = require('../models/coachResponseModel');
const { createCoachResponse, createFallbackCoachResponse } = require('../services/coachService');
const { loadState, canUse } = require('../services/entitlements');
const assessmentModel = require('../models/assessmentModel');
const { log } = require('../utils/log');
const trackModel = require('../models/trackModel');
const { normalizeRoadmapContent, flattenRoadmapDays } = require('../utils/roadmapContent');

async function createCheckinEntry(req, res) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const userId = req.session.userId;
  const { roadmapId } = req.valid.params;

  // Ownership check — only the roadmap owner can check in.
  const roadmap = await roadmapModel.getRoadmapById(roadmapId);
  if (!roadmap || roadmap.user_id !== userId) {
    return res.status(404).send('Roadmap not found');
  }

  const { notes } = req.valid.body;
  if (!notes) {
    return res.redirect(`/roadmaps/${roadmapId}?message=empty_notes`);
  }

  const today = new Date().toISOString().split('T')[0];

  const existingCheckin = await checkinModel.getCheckinByDate(userId, roadmapId, today);
  if (existingCheckin) {
    return res.redirect(`/roadmaps/${roadmapId}?message=already_checked_in`);
  }

  const checkin = await checkinModel.createCheckin(userId, roadmapId, notes);

  // Generate the coach response; any failure falls back and never blocks the check-in
  try {
    const checkins = await checkinModel.getCheckinsByRoadmap(userId, roadmapId);

    const allDays = flattenRoadmapDays(normalizeRoadmapContent(roadmap.content, { strict: false }));

    const currentDayNumber = checkins.length + 1;
    const completedTask = currentDayNumber > 1 ? allDays[currentDayNumber - 2] || null : null;
    const nextTask = currentDayNumber <= allDays.length ? allDays[currentDayNumber - 1] : null;
    // The project for the week the learner is in (the week of the day just completed).
    const weeklyProject = (completedTask || nextTask)?.week_project || null;
    const track = await trackModel.getTrackById(roadmap.track_id);

    let profile = null;
    if (roadmap.assessment_id) {
      const assessment = await assessmentModel.getAssessmentById(roadmap.assessment_id);
      if (assessment) {
        profile = { level: assessment.level, topicScores: assessment.topic_scores };
      }
    }

    const context = {
      profile,
      trackName: track ? track.name : null,
      goal: roadmap.goal,
      completedTask,
      checkinNotes: notes,
      weeklyProject,
      nextTask,
      userId // for the llm_calls log only; never sent to the model
    };

    // The AI coach is a paid feature (Premium or a bootcamp cohort); Free gets the template reply
    // and costs no AI call.
    const paid = canUse(await loadState(userId), 'ai_coach');
    const coachResponse = paid ? await createCoachResponse(context) : createFallbackCoachResponse(nextTask);
    await coachResponseModel.createCoachResponse(
      checkin.id,
      coachResponse.acknowledgement,
      coachResponse.insight,
      coachResponse.nextAction,
      coachResponse.isFallback
    );
  } catch (err) {
    // Coach response failure should not block the check-in
    log.error('Failed to generate coach response:', err.message);
  }

  res.redirect(`/roadmaps/${roadmapId}`);
}

module.exports = { createCheckinEntry };
