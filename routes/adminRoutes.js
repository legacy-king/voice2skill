const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');

// Founder admin view: read-only, so GET only. Access is checked inside (users.is_admin).
router.get('/admin', adminController.adminHome);
router.get('/admin/cohorts/:id', adminController.adminCohort);

module.exports = router;
