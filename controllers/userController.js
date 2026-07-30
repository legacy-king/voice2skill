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
    // no user found — what should happen here?
   return res.status(400).send("User Not Found!")
    
  }

  const passwordMatches = await bcrypt.compare(password, existingUser.password_hash);
  if (!passwordMatches) {
    // password wrong — what should happen here?
      return res.status(400).send('Incorrect Password')
  }

  // if we reach here, both checks passed — set the session and redirect
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
  res.render('login');
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