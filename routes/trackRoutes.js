const express = require('express');
const router = express.Router();
const trackController = require('../controllers/trackController');

router.get('/tracks', trackController.listTracks);

module.exports = router;