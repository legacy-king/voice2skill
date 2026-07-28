const trackModel = require('../models/trackModel');

async function listTracks(req, res) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const tracks = await trackModel.getAllTracks();
  res.render('tracks', { tracks });
}

module.exports = { listTracks };