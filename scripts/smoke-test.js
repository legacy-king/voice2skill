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
    ['Speak it.', 'Learn it. Earn it.', 'Start learning free', 'Web Development', 'Cybersecurity',
     'Skip to content', 'og:title', 'og:description', 'twitter:card', 'canonical', 'id="main"']],

  ['login (no error)', 'login.ejs', {},
    ['Welcome back', 'Log in', 'Sign up free', '_csrf', 'Skip to content', 'noindex', 'id="main"']],
  ['login (wrong password)', 'login.ejs', { error: 'wrong_password' },
    ['Incorrect password. Try again.']],
  ['login (not found)', 'login.ejs', { error: 'not_found' },
    ['No account found with that email.']],
  ['login (missing fields)', 'login.ejs', { error: 'missing' },
    ['Please enter both your email and password.']],
  ['login (not verified)', 'login.ejs', { error: 'not_verified' },
    ['Please verify your email first', 'resend the link']],
  ['login (password reset done)', 'login.ejs', { error: 'password_reset' },
    ['Password updated. Log in with your new password']],

  ['forgot-password (default)', 'forgot-password.ejs', { sent: false, error: null },
    ['Reset your password', 'Send reset link', '_csrf', 'noindex', 'Skip to content']],
  ['forgot-password (sent)', 'forgot-password.ejs', { sent: true, error: null },
    ['expires in 30 minutes', 'Back to login']],
  ['forgot-password (expired token)', 'forgot-password.ejs', { sent: false, error: 'expired_token' },
    ['invalid or has expired']],

  ['reset-password (default)', 'reset-password.ejs', { token: 'abc123', error: null },
    ['Set a new password', 'New password (min 8 chars)', 'Update password', '_csrf', 'value="abc123"', 'noindex', 'Skip to content']],
  ['reset-password (weak)', 'reset-password.ejs', { token: 'abc123', error: 'weak' },
    ['Password must be at least 8 characters.']],

  ['verify-email (sent)', 'verify-email.ejs', { sent: true, error: null },
    ['Verify your email', 'confirmation link', 'Resend verification email', '_csrf', 'noindex', 'Skip to content']],
  ['verify-email (invalid token)', 'verify-email.ejs', { sent: false, error: 'invalid' },
    ['invalid or has expired', 'Resend verification email']],
  ['verify-email (send failed)', 'verify-email.ejs', { sent: false, error: 'send_failed' },
    ['couldn\'t send the email', 'try again']],
  ['verify-email (default)', 'verify-email.ejs', { sent: false, error: null },
    ['we\'ll send you a verification link', 'Resend verification email']],

  ['signup', 'signup.ejs', {},
    ['Create your account', 'Start learning free', 'Already have an account?', 'Password (min 8 chars)', '_csrf', 'noindex', 'visually-hidden']],
  ['signup (name error)', 'signup.ejs', { error: 'name' },
    ['Please enter your name.']],
  ['signup (password error)', 'signup.ejs', { error: 'password' },
    ['Password must be at least 8 characters.']],
  ['signup (taken error)', 'signup.ejs', { error: 'taken' },
    ['already registered']],

  ['change-password (default)', 'change-password.ejs', { user, error: null, success: false },
    ['Change password', 'Current password', 'New password (min 8 chars)', 'Update password', '_csrf', 'Back to dashboard', 'noindex', 'Skip to content']],
  ['change-password (wrong current)', 'change-password.ejs', { user, error: 'wrong_current', success: false },
    ['Current password is incorrect']],
  ['change-password (weak)', 'change-password.ejs', { user, error: 'weak', success: false },
    ['Password must be at least 8 characters.']],
  ['change-password (missing)', 'change-password.ejs', { user, error: 'missing', success: false },
    ['Enter both your current and new password.']],
  ['change-password (success)', 'change-password.ejs', { user, error: null, success: true },
    ['Password updated. Other devices have been signed out.']],

  ['security (two sessions)', 'security.ejs',
    {
      user,
      sessions: [
        { sid: 'aaa', isCurrent: true, device: 'Chrome · Windows', ip: '1.2.3.4', signedInAt: new Date('2026-08-01'), lastActiveAt: new Date('2026-08-02T10:30:00'), expiresAt: new Date('2026-08-08') },
        { sid: 'bbb', isCurrent: false, device: 'Safari · iOS', ip: '5.6.7.8', signedInAt: new Date('2026-07-30'), lastActiveAt: new Date('2026-08-01T14:00:00'), expiresAt: new Date('2026-08-06') }
      ],
      error: null,
      success: false
    },
    ['Security settings', 'Active sessions', '2 devices', 'Chrome · Windows', 'Safari · iOS', 'This device', 'IP 1.2.3.4', 'IP 5.6.7.8', 'Active now', 'Last active', 'Revoke', 'name="sid" value="bbb"', '_csrf', 'Change password', 'noindex', 'Skip to content']],
  ['security (no sessions)', 'security.ejs', { user, sessions: [], error: null, success: false },
    ['No active sessions found']],
  ['security (self-revoke blocked)', 'security.ejs', { user, sessions: [], error: 'self', success: false },
    ["can't revoke the device you're currently using"]],
  ['security (revoke success)', 'security.ejs', { user, sessions: [], error: null, success: true },
    ['Session revoked']],

  ['dashboard', 'dashboard.ejs', { user, tracks, goalError: null, goalValue: '' },
    ['Maya', 'maya@example.com', 'Map my goal', 'Browse all tracks', 'I want to learn', '8', 'tracks', 'check-in', 'Web Development', 'Speak your goal', 'noindex', 'Skip to content']],

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
     'action="/tracks/1/select"', 'action="/tracks/5/select"', '_csrf', 'noindex', 'id="main"']],

  ['assessment (question 1)', 'assessment.ejs', {
    track: { id: 1, name: 'Software Engineering' },
    question: { id: 'html_basics', question: 'What does the <a> tag do in HTML?', options: [
      { value: 'a', label: 'Creates a hyperlink' },
      { value: 'b', label: 'Makes text bold' }
    ]},
    questionNumber: 1,
    totalQuestions: 8,
    answers: {},
    goal: '',
    error: null
  }, ['Capability Assessment', 'Question 1 of 8', 'What does the', 'tag do in HTML', 'Creates a hyperlink', '_csrf', 'noindex']],

  ['assessment result', 'assessment-result.ejs', {
    track: { id: 1, name: 'Software Engineering', description: 'Build reliable, scalable software systems.' },
    goal: 'become a backend engineer',
    level: 'builder',
    score: 4
  }, ['Assessment complete', 'Builder', '4 out of 8', 'become a backend engineer', 'Build my roadmap', 'action="/tracks/1/select"', 'name="goal"', '_csrf']],

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
     'Day 22 of 56', 'Week 4', '2 check-ins completed', 'noindex', 'visually-hidden', 'Skip to content']],

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
    }, ['completed your roadmap', 'Day 57 of 56']],

  ['roadmap (with coach response)', 'roadmap.ejs',
    {
      roadmap: { id: 42, goal: 'learn React' },
      trackName: 'Software Engineering',
      checkins: [
        { checkin_date: '2026-08-19', notes: 'Built a todo app', coachResponse: {
          acknowledgement: 'Great work on the todo app!',
          insight: 'Building real projects is the best way to learn React.',
          next_action: 'Start learning about React hooks next.',
          is_fallback: false
        }}
      ],
      message: null,
      streak: 1,
      todayTask: weekdayTask,
      currentDayNumber: 2,
      totalDays: 56,
      isComplete: false
    }, ['Your coach', 'AI Coach', 'Great work on the todo app', 'hooks next', 'Built a todo app']],
];

let failures = 0;

// Mirrors what the real app always provides via res.locals (csrf middleware + appUrl).
const DEFAULT_LOCALS = { csrfToken: 'test-csrf-token', appUrl: 'https://voice2skill.test' };

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

// ---- Capability assessment unit checks ----
const { scoreAssessment, getNextQuestion } = require('../utils/capabilityAssessment');
const { getLevelContext, analyzeTopicScores } = require('../utils/coachService');

// Foundation level (0-2 correct)
const foundationAnswers = { html_basics: 'a', css_box_model: 'a' };
const foundationResult = scoreAssessment(foundationAnswers);
if (foundationResult.level !== 'foundation') {
  failures++;
  console.error(`✗ foundation level: got ${foundationResult.level}, expected foundation`);
} else {
  console.log(`✓ foundation level (${foundationResult.score} correct)`);
}

// Professional level (6+ correct in the eight-question diagnostic)
const professionalAnswers = {
  html_basics: 'a', js_basics: 'a', git_basics: 'a', debugging: 'a',
  apis: 'a', testing: 'a', architecture: 'a', architecture_patterns: 'a'
};
const professionalResult = scoreAssessment(professionalAnswers);
if (professionalResult.level !== 'professional') {
  failures++;
  console.error(`✗ professional level: got ${professionalResult.level}, expected professional`);
} else {
  console.log(`✓ professional level (${professionalResult.score} correct)`);
}

// Builder level (3-5 correct)
const builderAnswers = { html_basics: 'a', js_basics: 'a', git_basics: 'a', debugging: 'a' };
const builderResult = scoreAssessment(builderAnswers);
if (builderResult.level !== 'builder') {
  failures++;
  console.error(`✗ builder level: got ${builderResult.level}, expected builder`);
} else {
  console.log(`✓ builder level (${builderResult.score} correct)`);
}

// Adaptive follow-up: strong core answers should earn an architecture question.
const adaptiveAnswers = {
  html_basics: 'a', js_basics: 'a', git_basics: 'a', debugging: 'a',
  apis: 'a', testing: 'a', architecture: 'a'
};
const nextQ = getNextQuestion(adaptiveAnswers);
if (!nextQ || nextQ.id !== 'architecture_patterns') {
  failures++;
  console.error(`✗ adaptive follow-up: expected architecture_patterns, got ${nextQ?.id}`);
} else {
  console.log('✓ adaptive follow-up → architecture_patterns after strong core answers');
}

// ---- Coach service unit checks ----
const foundationContext = getLevelContext('foundation', {});
if (!foundationContext.tone || !foundationContext.emphasis) {
  failures++;
  console.error('✗ getLevelContext(foundation): missing tone or emphasis');
} else {
  console.log('✓ getLevelContext(foundation) returns valid context');
}

const builderContext = getLevelContext('builder', {});
if (!builderContext.tone || !builderContext.emphasis) {
  failures++;
  console.error('✗ getLevelContext(builder): missing tone or emphasis');
} else {
  console.log('✓ getLevelContext(builder) returns valid context');
}

const profContext = getLevelContext('professional', {});
if (!profContext.tone || !profContext.emphasis) {
  failures++;
  console.error('✗ getLevelContext(professional): missing tone or emphasis');
} else {
  console.log('✓ getLevelContext(professional) returns valid context');
}

const topicScores = { javascript: { correct: 4, total: 4 }, git: { correct: 0, total: 3 } };
const topicAnalysis = analyzeTopicScores(topicScores);
if (!topicAnalysis.strengths.includes('javascript') || !topicAnalysis.weaknesses.includes('git')) {
  failures++;
  console.error('✗ analyzeTopicScores: incorrect strengths/weaknesses');
} else {
  console.log('✓ analyzeTopicScores correctly identifies strengths and weaknesses');
}

console.log('');
if (failures > 0) {
  console.error(`Smoke test FAILED — ${failures} case(s) failed.`);
  process.exit(1);
}
console.log(`Smoke test passed — all ${cases.length} render cases + ${matcherCases.length} matcher cases + rank/search checks + 4 capability checks OK.`);
