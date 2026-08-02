const checkinModel = require('../models/checkinModel');
const roadmapModel = require('../models/roadmapModel');

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

  await checkinModel.createCheckin(userId, roadmapId, notes);
  res.redirect(`/roadmaps/${roadmapId}`);
}

module.exports = { createCheckinEntry };