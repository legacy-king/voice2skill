const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');

router.post('/signup', userController.signup);
router.post('/login', userController.login);
router.get('/dashboard', userController.dashboard);
router.get('/login', userController.loginPage);
router.get('/signup', userController.signupPage);
router.get('/', (req, res) => {
  res.redirect('/login');
});

module.exports = router;