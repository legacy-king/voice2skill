const checkinModel = require('../models/checkinModel');

async function createCheckinEntry(req, res) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const userId = req.session.userId;
  const roadmapId = req.params.roadmapId;
  const notes = req.body.notes;
  const today = new Date().toISOString().split('T')[0];

  const existingCheckin = await checkinModel.getCheckinByDate(userId, roadmapId, today);
  
   if (existingCheckin) {
  return res.redirect(`/roadmaps/${roadmapId}?message=already_checked_in`);
}


  await checkinModel.createCheckin(userId, roadmapId, notes);
  res.redirect(`/roadmaps/${roadmapId}`);
}

module.exports = { createCheckinEntry };