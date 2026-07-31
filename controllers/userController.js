const bcrypt = require('bcrypt');
const userModel = require('../models/userModel');
const roadmapModel = require('../models/roadmapModel');

async function signup(req, res) {
  const { name, email, password } = req.body;

  const existingUser = await userModel.findUserByEmail(email);
  if (existingUser) {
    return res.status(400).send('Email already registered');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const newUser = await userModel.createUser(name, email, passwordHash);

  req.session.userId = newUser.id;
  res.redirect('/dashboard');
}

async function login(req, res) {
  const { email, password } = req.body;

  const existingUser = await userModel.findUserByEmail(email);
  if (!existingUser) {
    return res.redirect('/login?error=not_found');
  }

  const passwordMatches = await bcrypt.compare(password, existingUser.password_hash);
  if (!passwordMatches) {
    return res.redirect('/login?error=wrong_password');
  }

  req.session.userId = existingUser.id;
  res.redirect('/dashboard');
}

  async function dashboard(req, res) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const user = await userModel.findUserById(req.session.userId);
  const existingRoadmap = await roadmapModel.getRoadmapByUser(req.session.userId);

  if (existingRoadmap) {
    return res.redirect(`/roadmaps/${existingRoadmap.id}`);
  }

  res.render('dashboard', { user });
}

function loginPage(req, res) {
  const error = req.query.error;
  res.render('login', { error });
}

function signupPage(req, res) {
  res.render('signup');
}

function logout(req, res) {
  req.session.destroy(() => {
    res.redirect('/login');
  });
}

module.exports = { signup, login, dashboard, loginPage, signupPage, logout };