#!/usr/bin/env node
/**
 * EJS smoke test — renders every view with representative mock data.
 *
 * Catches template syntax errors, missing includes (partials), stray `<%`
 * tags leaking into output, and variables referenced but not provided.
 * Each case also asserts key content strings appear in the output, which
 * catches silently-undefined locals (EJS renders them as empty strings —
 * e.g. a typo like `user.nmae` would otherwise pass unnoticed).
 *
 * No database or server required.
 *
 * Usage: npm test   (or: node scripts/smoke-test.js)
 */
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

const VIEWS_DIR = path.join(__dirname, '..', 'views');

// ---- Representative mock data (mirrors what controllers pass) ----
const user = { name: 'Maya', email: 'maya@example.com' };

const tracks = [
  { id: 1, name: 'Web Development', description: 'HTML, CSS, JavaScript — build and ship real sites.' },
  { id: 2, name: 'UI/UX Design', description: 'Design thinking, Figma, and interfaces people love.' },
  { id: 3, name: 'Data Analysis', description: 'Spreadsheets, SQL, and insights that drive decisions.' },
  { id: 4, name: 'Digital Marketing', description: 'Content, SEO, and campaigns that reach people.' },
  { id: 5, name: 'Cybersecurity', description: 'Fundamentals of protecting systems and data.' }
];

const checkins = [
  { checkin_date: '2026-07-30', notes: 'Finished HTML semantics module.' },
  { checkin_date: '2026-07-31', notes: 'Built my first form with CSS.' }
];

const weekdayTask = {
  day_number: 22,
  week_number: 4,
  week_focus: 'JavaScript Fundamentals',
  day_type: 'weekday',
  task: 'Today, learn JS functions and scope: declarations, expressions, and closures.',
  resource_name: 'MDN Web Docs',
  resource_url: 'https://developer.mozilla.org',
  video_search_term: 'JavaScript functions crash course'
};

const weekendTask = { ...weekdayTask, day_type: 'weekend', day_number: 6 };

// ---- Case list: (label, template file, locals, expected content strings) ----
const cases = [
  ['landing', 'landing.ejs', {},
    ['Speak it.', 'Learn it. Earn it.', 'Start learning free', 'Web Development', 'Cybersecurity']],

  ['login (no error)', 'login.ejs', {},
    ['Welcome back', 'Log in', 'Sign up free', '_csrf']],
  ['login (wrong password)', 'login.ejs', { error: 'wrong_password' },
    ['Incorrect password. Try again.']],
  ['login (not found)', 'login.ejs', { error: 'not_found' },
    ['No account found with that email.']],
  ['login (missing fields)', 'login.ejs', { error: 'missing' },
    ['Please enter both your email and password.']],
  ['login (not verified)', 'login.ejs', { error: 'not_verified' },
    ['Please verify your email first', 'resend the link']],

  ['verify-email (sent)', 'verify-email.ejs', { sent: true, error: null },
    ['Verify your email', 'confirmation link', 'Resend verification email', '_csrf']],
  ['verify-email (invalid token)', 'verify-email.ejs', { sent: false, error: 'invalid' },
    ['invalid or has expired', 'Resend verification email']],
  ['verify-email (send failed)', 'verify-email.ejs', { sent: false, error: 'send_failed' },
    ['couldn\'t send the email', 'try again']],
  ['verify-email (default)', 'verify-email.ejs', { sent: false, error: null },
    ['we\'ll send you a verification link', 'Resend verification email']],

  ['signup', 'signup.ejs', {},
    ['Create your account', 'Start learning free', 'Already have an account?', 'Password (min 8 chars)', '_csrf']],
  ['signup (name error)', 'signup.ejs', { error: 'name' },
    ['Please enter your name.']],
  ['signup (password error)', 'signup.ejs', { error: 'password' },
    ['Password must be at least 8 characters.']],
  ['signup (taken error)', 'signup.ejs', { error: 'taken' },
    ['already registered']],

  ['dashboard', 'dashboard.ejs', { user, tracks, goalError: null, goalValue: '' },
    ['Maya', 'maya@example.com', 'Map my goal', 'Browse all tracks', 'I want to learn', '8', 'tracks', 'check-in', 'Web Development', 'Speak your goal']],

  ['goal confirm', 'goal-confirm.ejs', { goal: 'design a mobile app interface', track: tracks[1], alternatives: [tracks[0], tracks[3]], glyphs: ['</>', '✦', '∑', '◎', '⚿'] },
    ['design a mobile app interface', 'UI/UX Design', 'Build my 8-week roadmap', 'Pick a different track', 'Edit my goal', 'action="/tracks/2/select"', 'name="goal"', 'Not quite it?', 'Web Development', 'Digital Marketing', 'action="/tracks/1/select"', 'action="/tracks/4/select"', '_csrf']],

  ['goal confirm (no alternatives)', 'goal-confirm.ejs', { goal: 'design a mobile app interface', track: tracks[1], alternatives: [], glyphs: ['</>', '✦', '∑', '◎', '⚿'] },
    ['design a mobile app interface', 'UI/UX Design', 'Build my 8-week roadmap']],

  ['dashboard (goal no match)', 'dashboard.ejs', { user, tracks, goalError: 'no_match', goalValue: 'fly a plane' },
    ['fly a plane', 'couldn\'t match']],

  ['dashboard (empty goal)', 'dashboard.ejs', { user, tracks, goalError: 'empty', goalValue: '' },
    ['Tell us what you want to learn first']],

  ['tracks', 'tracks.ejs', { tracks },
    ['Choose your', 'Web Development', 'UI/UX Design', 'Data Analysis', 'Digital Marketing', 'Cybersecurity',
     'action="/tracks/1/select"', 'action="/tracks/5/select"', '_csrf']],

  ['roadmap (active weekday)', 'roadmap.ejs',
    {
      roadmap: { id: 42 },
      trackName: 'Web Development',
      checkins,
      message: null,
      streak: 12,
      todayTask: weekdayTask,
      currentDayNumber: 22,
      totalDays: 56,
      isComplete: false
    },
    ['12-day streak', 'JavaScript Fundamentals', 'MDN Web Docs', '/roadmaps/42/checkin',
     'Day 22 of 56', 'Week 4', '2 check-ins completed']],

  ['roadmap (with persisted goal + video phrase)', 'roadmap.ejs',
    {
      roadmap: { id: 42, goal: 'build websites for my small business' },
      trackName: 'Web Development',
      checkins: [],
      message: null,
      streak: 0,
      todayTask: weekdayTask,
      currentDayNumber: 1,
      totalDays: 56,
      isComplete: false,
      videoSearchPhrase: 'build websites small business JavaScript functions crash course'
    },
    ['Your goal', 'build websites for my small business', 'search_query=build%20websites%20small%20business%20JavaScript%20functions%20crash%20course', '_csrf']],

  ['roadmap (empty notes message)', 'roadmap.ejs',
    {
      roadmap: { id: 42, goal: null },
      trackName: 'Web Development',
      checkins: [],
      message: 'empty_notes',
      streak: 0,
      todayTask: weekdayTask,
      currentDayNumber: 1,
      totalDays: 56,
      isComplete: false
    },
    ['Tell your coach what you worked on']],

  ['roadmap (weekend light day)', 'roadmap.ejs',
    {
      roadmap: { id: 42 },
      trackName: 'UI/UX Design',
      checkins: [],
      message: null,
      streak: 0,
      todayTask: weekendTask,
      currentDayNumber: 6,
      totalDays: 56,
      isComplete: false
    },
    ['Light day — review', 'No check-ins yet']],

  ['roadmap (already checked in)', 'roadmap.ejs',
    {
      roadmap: { id: 42 },
      trackName: 'Web Development',
      checkins,
      message: 'already_checked_in',
      streak: 12,
      todayTask: weekdayTask,
      currentDayNumber: 22,
      totalDays: 56,
      isComplete: false
    },
    ['already checked in today']],

  ['roadmap (complete)', 'roadmap.ejs',
    {
      roadmap: { id: 42 },
      trackName: 'Data Analysis',
      checkins,
      message: null,
      streak: 0,
      todayTask: null,
      currentDayNumber: 57,
      totalDays: 56,
      isComplete: true
    },
    ['completed your roadmap', 'Day 57 of 56']]
];

let failures = 0;

// Mirrors what the real app always provides via res.locals (csrf middleware).
const DEFAULT_LOCALS = { csrfToken: 'test-csrf-token' };

for (const [label, file, locals, expect] of cases) {
  const fullPath = path.join(VIEWS_DIR, file);
  try {
    const source = fs.readFileSync(fullPath, 'utf8');
    const rendered = ejs.render(source, { ...DEFAULT_LOCALS, ...locals }, { filename: fullPath });

    const strayTags = (rendered.match(/<%[=-]?/g) || []).length;
    if (strayTags > 0) {
      failures++;
      console.error(`✗ ${label}: ${strayTags} stray EJS tag(s) leaked into rendered HTML`);
      continue;
    }

    const missing = expect.filter(str => !rendered.includes(str));
    if (missing.length > 0) {
      failures++;
      console.error(`✗ ${label}: expected content missing → ${JSON.stringify(missing)}`);
      continue;
    }

    console.log(`✓ ${label}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${label}: ${err.message}`);
  }
}

// ---- Goal matcher unit checks ----
const { matchTrackToGoal, rankTracksForGoal, goalToSearchPhrase } = require('../utils/goalMatcher');

const matcherCases = [
  ['I want to learn how to build websites', 'Web Development'],
  ['make me an app for my business', 'Web Development'],
  ['learn python and sql', 'Data Analysis'],
  ['data analysis with spreadsheets', 'Data Analysis'],
  ['design a mobile app interface', 'UI/UX Design'],
  ['run instagram ads for my shop', 'Digital Marketing'],
  ['learn ethical hacking', 'Cybersecurity'],
  ['build a responsive website with css', 'Web Development'],
  // typo tolerance
  ['i want to learn pythin', 'Data Analysis'],
  ['build websits', 'Web Development'],
  ['run markteing campaigns', 'Digital Marketing'],
  ['learn ethical hackng', 'Cybersecurity'],
  ['desgn a mobile app', 'UI/UX Design'],
  ['learn html and javascrit', 'Web Development'],
  // exact beats fuzzy on a points tie: UI/UX fuzzy 'design' (1pt) vs Data exact 'data' (1pt)
  ['desgin data', 'Data Analysis'],
  ['fly a plane', null],
  ['', null]
];

for (const [goal, expected] of matcherCases) {
  const result = matchTrackToGoal(goal, tracks);
  const got = result ? result.name : null;
  if (got !== expected) {
    failures++;
    console.error(`✗ goal "${goal}" → got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  } else {
    console.log(`✓ goal "${goal}" → ${got}`);
  }
}

// ---- Ranked alternatives + search phrase checks ----
function expectRanked(goal, expectedTop, expectedCount) {
  const ranked = rankTracksForGoal(goal, tracks);
  const top = ranked.length ? ranked[0].track.name : null;
  const ok = top === expectedTop && ranked.length >= expectedCount;
  if (!ok) {
    failures++;
    console.error(`✗ rank "${goal}" → top ${JSON.stringify(top)}, got ${ranked.length} matches (expected ${expectedTop}, ≥${expectedCount})`);
  } else {
    console.log(`✓ rank "${goal}" → top ${top}, ${ranked.length} match(es)`);
  }
}

expectRanked('design a mobile app interface', 'UI/UX Design', 2);
const altNames = rankTracksForGoal('design a mobile app interface', tracks).map(e => e.track.name);
if (!altNames.includes('Web Development')) {
  failures++;
  console.error('✗ alternatives should include Web Development for "design a mobile app interface"');
} else {
  console.log('✓ alternatives include Web Development for "design a mobile app interface"');
}

expectRanked('fly a plane', null, 0);

const searchCases = [
  ['I want to learn how to build websites', 'learn build websites'],
  ['design a mobile app interface', 'design mobile app interface'],
  ['', ''],
  ['learn python and sql', 'learn python sql']
];
for (const [goal, expected] of searchCases) {
  const got = goalToSearchPhrase(goal);
  if (got !== expected) {
    failures++;
    console.error(`✗ searchPhrase "${goal}" → got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  } else {
    console.log(`✓ searchPhrase "${goal}" → ${got}`);
  }
}

console.log('');
if (failures > 0) {
  console.error(`Smoke test FAILED — ${failures} case(s) failed.`);
  process.exit(1);
}
console.log(`Smoke test passed — all ${cases.length} render cases + ${matcherCases.length} matcher cases + rank/search checks OK.`);
