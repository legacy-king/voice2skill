const { getQuestion, getNextQuestion, scoreAssessment } = require('../utils/capabilityAssessment');
const assessmentModel = require('../models/assessmentModel');
const trackModel = require('../models/trackModel');

/**
 * GET /tracks/:trackId/assessment
 * Renders one question at a time with progress.
 */
async function renderAssessment(req, res) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const { trackId } = req.valid.params;

  const track = await trackModel.getTrackById(trackId);
  if (!track) {
    return res.status(404).send('Track not found');
  }

  // Only Software Engineering requires assessment
  if (track.name !== 'Software Engineering') {
    return res.redirect(`/tracks`);
  }

  const answers = req.session.assessmentAnswers || {};
  const goal = req.session.assessmentGoal || '';

  const nextQuestion = getNextQuestion(answers);
  if (!nextQuestion) {
    // All questions answered — redirect to completion
    return res.redirect(`/tracks/${trackId}/assessment/complete`);
  }

  const totalQuestions = require('../utils/capabilityAssessment').assessmentQuestionLimit;
  const answeredCount = Object.keys(answers).length;

  res.render('assessment', {
    track,
    question: nextQuestion,
    questionNumber: answeredCount + 1,
    totalQuestions,
    answers,
    goal,
    error: null
  });
}

/**
 * POST /tracks/:trackId/assessment
 * Processes an answer and shows the next question.
 */
async function processAnswer(req, res) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const { trackId } = req.valid.params;

  const track = await trackModel.getTrackById(trackId);
  if (!track || track.name !== 'Software Engineering') {
    return res.redirect('/tracks');
  }

  const { questionId, answer, goal } = req.valid.body;

  // Initialize session data
  if (!req.session.assessmentAnswers) {
    req.session.assessmentAnswers = {};
  }
  if (goal && !req.session.assessmentGoal) {
    req.session.assessmentGoal = goal.trim().slice(0, 200);
  }

  // An answer must be for the exact question the learner is currently shown.
  // This prevents a forged request from skipping directly to arbitrary questions.
  const question = getQuestion(questionId);
  const expectedQuestion = getNextQuestion(req.session.assessmentAnswers);
  const validAnswer = question && question.options.some(option => option.value === answer);
  if (!question || !answer || !validAnswer || !expectedQuestion || question.id !== expectedQuestion.id) {
    const totalQuestions = require('../utils/capabilityAssessment').assessmentQuestionLimit;
    const answeredCount = Object.keys(req.session.assessmentAnswers).length;
    return res.render('assessment', {
      track,
      question: question || getQuestion('html_basics'),
      questionNumber: answeredCount + 1,
      totalQuestions,
      answers: req.session.assessmentAnswers,
      goal: req.session.assessmentGoal || '',
      error: 'Please select an answer'
    });
  }

  // Store answer
  req.session.assessmentAnswers[questionId] = answer;

  // Check if assessment is complete
  const nextQuestion = getNextQuestion(req.session.assessmentAnswers);
  if (!nextQuestion) {
    return res.redirect(`/tracks/${trackId}/assessment/complete`);
  }

  res.redirect(`/tracks/${trackId}/assessment`);
}

/**
 * GET /tracks/:trackId/assessment/complete
 * Scores the assessment, persists it, and lets the learner explicitly create
 * their CSRF-protected roadmap.
 */
async function completeAssessment(req, res) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const { trackId } = req.valid.params;

  const track = await trackModel.getTrackById(trackId);
  if (!track || track.name !== 'Software Engineering') {
    return res.redirect('/tracks');
  }

  // A refresh of this GET route must not create a second, blank assessment.
  // Re-show the saved result until the learner submits the roadmap form.
  if (!req.session.assessmentAnswers && req.session.assessmentId) {
    const assessment = await assessmentModel.getLatestAssessment(req.session.userId, trackId);
    if (assessment && assessment.id === req.session.assessmentId) {
      return res.render('assessment-result', {
        track,
        goal: req.session.assessmentGoal || '',
        level: assessment.level,
        score: assessment.score
      });
    }
  }

  const answers = req.session.assessmentAnswers || {};
  const goal = req.session.assessmentGoal || '';

  // Score the assessment
  const result = scoreAssessment(answers);

  // Persist assessment
  const assessment = await assessmentModel.createAssessment(
    req.session.userId,
    trackId,
    result.level,
    result.score,
    result.topicScores,
    result.answers
  );

  // Store assessment ID in session for roadmap creation
  req.session.assessmentId = assessment.id;
  req.session.assessmentLevel = result.level;

  // Clear answers, but keep the goal for the confirmation form and refreshes.
  delete req.session.assessmentAnswers;

  res.render('assessment-result', {
    track,
    goal,
    level: result.level,
    score: result.score
  });
}

module.exports = { renderAssessment, processAnswer, completeAssessment };
