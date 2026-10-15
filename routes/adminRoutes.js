const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { validate, onInvalid, z, id } = require('../middleware/validate');

// Founder admin view: read-only, so GET only. Access is checked inside (users.is_admin).
router.get('/admin', adminController.adminHome);
router.get('/admin/cohorts/:id', validate({ params: z.object({ id: id() }) }, onInvalid.notFound), adminController.adminCohort);

module.exports = router;
