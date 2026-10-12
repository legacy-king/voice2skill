const checkinModel = require('../models/checkinModel');
const roadmapModel = require('../models/roadmapModel');
const coachResponseModel = require('../models/coachResponseModel');
const { createCoachResponse } = require('../utils/coachService');
const assessmentModel = require('../models/assessmentModel');

async function createCheckinEntry(req, res) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const userId = req.session.userId;
  const roadmapId = Number.parseInt(req.params.roadmapId, 10);

  if (!Number.isInteger(roadmapId)) {
    return res.status(404).send('Roadmap not found');
  }

  // Ownership check — only the roadmap owner can check in.
  const roadmap = await roadmapModel.getRoadmapById(roadmapId);
  if (!roadmap || roadmap.user_id !== userId) {
    return res.status(404).send('Roadmap not found');
  }

  const notes = typeof req.body.notes === 'string' ? req.body.notes.trim().slice(0, 2000) : '';
  if (!notes) {
    return res.redirect(`/roadmaps/${roadmapId}?message=empty_notes`);
  }

  const today = new Date().toISOString().split('T')[0];

  const existingCheckin = await checkinModel.getCheckinByDate(userId, roadmapId, today);
  if (existingCheckin) {
    return res.redirect(`/roadmaps/${roadmapId}?message=already_checked_in`);
  }

  const checkin = await checkinModel.createCheckin(userId, roadmapId, notes);

  // Generate coach response (fire-and-forget — don't block the redirect)
  try {
    const checkins = await checkinModel.getCheckinsByRoadmap(userId, roadmapId);

    const allDays = roadmap.content.weeks.flatMap(week =>
      week.days.map(day => ({ ...day, week_focus: week.focus, week_number: week.week_number, week_project: week.project }))
    );

    const currentDayNumber = checkins.length + 1;
    const completedTask = currentDayNumber > 1 ? allDays[currentDayNumber - 2] : null;
    const nextTask = currentDayNumber <= allDays.length ? allDays[currentDayNumber - 1] : null;
    const weeklyProject = roadmap.content.weeks[Math.ceil((currentDayNumber - 1) / 7)]?.project || null;

    let profile = null;
    if (roadmap.assessment_id) {
      const assessment = await assessmentModel.getAssessmentById(roadmap.assessment_id);
      if (assessment) {
        profile = { level: assessment.level, topicScores: assessment.topic_scores };
      }
    }

    const context = {
      profile,
      goal: roadmap.goal,
      completedTask,
      checkinNotes: notes,
      weeklyProject,
      nextTask
    };

    const coachResponse = await createCoachResponse(context);
    await coachResponseModel.createCoachResponse(
      checkin.id,
      coachResponse.acknowledgement,
      coachResponse.insight,
      coachResponse.nextAction,
      coachResponse.isFallback
    );
  } catch (err) {
    // Coach response failure should not block the check-in
    console.error('Failed to generate coach response:', err.message);
  }

  res.redirect(`/roadmaps/${roadmapId}`);
}

module.exports = { createCheckinEntry };
