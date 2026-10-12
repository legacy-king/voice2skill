/**
 * Capability Assessment Engine
 *
 * Curated, deterministic assessment that grades Software Engineering learners
 * across foundational, builder, and professional levels.
 *
 * Topics: HTML/CSS, JavaScript, Git/GitHub, debugging, APIs, testing,
 * and architecture/system design.
 *
 * Scoring: Each correct answer = 1 point
 * The diagnostic asks seven core questions and one adaptive question:
 * - foundation: 0-2 correct
 * - builder: 3-5 correct
 * - professional: 6-8 correct
 */

const questions = [
  // ── HTML/CSS Foundations (3 questions) ──────────────────────────
  {
    id: 'html_basics',
    topic: 'foundations',
    difficulty: 'beginner',
    question: 'What does the <a> tag do in HTML?',
    options: [
      { value: 'a', label: 'Creates a hyperlink to another page or resource', correct: true },
      { value: 'b', label: 'Makes text bold', correct: false },
      { value: 'c', label: 'Inserts an image', correct: false },
      { value: 'd', label: 'Creates a paragraph', correct: false }
    ]
  },
  {
    id: 'css_box_model',
    topic: 'foundations',
    difficulty: 'beginner',
    question: 'In CSS, what properties make up the box model?',
    options: [
      { value: 'a', label: 'Content, padding, border, margin', correct: true },
      { value: 'b', label: 'Width, height, color, font', correct: false },
      { value: 'c', label: 'Display, position, float, clear', correct: false },
      { value: 'd', label: 'Background, text, image, link', correct: false }
    ]
  },
  {
    id: 'css_selectors',
    topic: 'foundations',
    difficulty: 'intermediate',
    question: 'What does ".container" select in CSS?',
    options: [
      { value: 'a', label: 'Elements with class="container"', correct: true },
      { value: 'b', label: 'An element with id="container"', correct: false },
      { value: 'c', label: 'The <container> HTML tag', correct: false },
      { value: 'd', label: 'All elements on the page', correct: false }
    ]
  },

  // ── JavaScript (4 questions) ───────────────────────────────────
  {
    id: 'js_basics',
    topic: 'javascript',
    difficulty: 'beginner',
    question: 'What is a closure in JavaScript?',
    options: [
      { value: 'a', label: 'A function that remembers variables from its outer scope', correct: true },
      { value: 'b', label: 'A way to close browser windows', correct: false },
      { value: 'c', label: 'A loop that stops automatically', correct: false },
      { value: 'd', label: 'A method to delete variables', correct: false }
    ]
  },
  {
    id: 'js_basics_advanced',
    topic: 'javascript',
    difficulty: 'intermediate',
    question: 'What is the difference between let and var in JavaScript?',
    options: [
      { value: 'a', label: 'let has block scope, var has function scope', correct: true },
      { value: 'b', label: 'var is newer than let', correct: false },
      { value: 'c', label: 'They are exactly the same', correct: false },
      { value: 'd', label: 'let can only store strings', correct: false }
    ]
  },
  {
    id: 'js_async',
    topic: 'javascript',
    difficulty: 'advanced',
    question: 'What does the "async/await" syntax do in JavaScript?',
    options: [
      { value: 'a', label: 'Makes asynchronous code look and behave like synchronous code', correct: true },
      { value: 'b', label: 'Makes code run faster', correct: false },
      { value: 'c', label: 'Creates multiple threads', correct: false },
      { value: 'd', label: 'Deletes the event loop', correct: false }
    ]
  },
  {
    id: 'js_frameworks',
    topic: 'javascript',
    difficulty: 'advanced',
    question: 'What is the main benefit of using a framework like React?',
    options: [
      { value: 'a', label: 'Component-based architecture for reusable UI pieces', correct: true },
      { value: 'b', label: 'It eliminates the need to write HTML', correct: false },
      { value: 'c', label: 'It replaces JavaScript entirely', correct: false },
      { value: 'd', label: 'It only works with Python', correct: false }
    ]
  },

  // ── Git/GitHub (3 questions) ───────────────────────────────────
  {
    id: 'git_basics',
    topic: 'git',
    difficulty: 'beginner',
    question: 'What does "git commit" do?',
    options: [
      { value: 'a', label: 'Saves staged changes to the local repository', correct: true },
      { value: 'b', label: 'Uploads code to GitHub', correct: false },
      { value: 'c', label: 'Deletes files from the project', correct: false },
      { value: 'd', label: 'Creates a new branch', correct: false }
    ]
  },
  {
    id: 'git_branching',
    topic: 'git',
    difficulty: 'intermediate',
    question: 'What is the purpose of git branches?',
    options: [
      { value: 'a', label: 'Develop features or fixes in isolation before merging', correct: true },
      { value: 'b', label: 'Delete old code permanently', correct: false },
      { value: 'c', label: 'Copy the entire repository', correct: false },
      { value: 'd', label: 'Only used for documentation', correct: false }
    ]
  },
  {
    id: 'git_collaboration',
    topic: 'git',
    difficulty: 'advanced',
    question: 'What is a pull request on GitHub?',
    options: [
      { value: 'a', label: 'A request to review and merge code changes into the main branch', correct: true },
      { value: 'b', label: 'A way to delete the repository', correct: false },
      { value: 'c', label: 'A command to download files', correct: false },
      { value: 'd', label: 'A method to encrypt code', correct: false }
    ]
  },

  // ── Debugging (2 questions) ────────────────────────────────────
  {
    id: 'debugging',
    topic: 'debugging',
    difficulty: 'beginner',
    question: 'When your code throws an error, what is a good first step?',
    options: [
      { value: 'a', label: 'Read the error message and stack trace carefully', correct: true },
      { value: 'b', label: 'Delete the file and start over', correct: false },
      { value: 'c', label: 'Search for a different tutorial', correct: false },
      { value: 'd', label: 'Ignore it and keep coding', correct: false }
    ]
  },
  {
    id: 'debugging_tools',
    topic: 'debugging',
    difficulty: 'intermediate',
    question: 'What does console.log() do in JavaScript?',
    options: [
      { value: 'a', label: 'Prints output to the browser console for debugging', correct: true },
      { value: 'b', label: 'Saves data to a database', correct: false },
      { value: 'c', label: 'Creates a new HTML element', correct: false },
      { value: 'd', label: 'Sends an email to the developer', correct: false }
    ]
  },

  // ── APIs (2 questions) ─────────────────────────────────────────
  {
    id: 'apis',
    topic: 'apis',
    difficulty: 'beginner',
    question: 'What does a REST API use to identify resources?',
    options: [
      { value: 'a', label: 'URLs (endpoints) with HTTP methods', correct: true },
      { value: 'b', label: 'Only email addresses', correct: false },
      { value: 'c', label: 'Binary machine code', correct: false },
      { value: 'd', label: 'Randomly generated passwords', correct: false }
    ]
  },
  {
    id: 'api_methods',
    topic: 'apis',
    difficulty: 'intermediate',
    question: 'Which HTTP method is typically used to create a new resource?',
    options: [
      { value: 'a', label: 'POST', correct: true },
      { value: 'b', label: 'GET', correct: false },
      { value: 'c', label: 'DELETE', correct: false },
      { value: 'd', label: 'HEAD', correct: false }
    ]
  },

  // ── Testing (2 questions) ──────────────────────────────────────
  {
    id: 'testing',
    topic: 'testing',
    difficulty: 'beginner',
    question: 'Why is automated testing important?',
    options: [
      { value: 'a', label: 'It catches regressions when code changes', correct: true },
      { value: 'b', label: 'It replaces the need for code reviews', correct: false },
      { value: 'c', label: 'It makes code run faster', correct: false },
      { value: 'd', label: 'It writes code for you', correct: false }
    ]
  },
  {
    id: 'testing_types',
    topic: 'testing',
    difficulty: 'intermediate',
    question: 'What is the difference between unit and integration tests?',
    options: [
      { value: 'a', label: 'Unit tests check individual functions; integration tests check how parts work together', correct: true },
      { value: 'b', label: 'They are exactly the same thing', correct: false },
      { value: 'c', label: 'Unit tests are slower than integration tests', correct: false },
      { value: 'd', label: 'Integration tests only work in production', correct: false }
    ]
  },

  // ── Architecture (2 questions) ─────────────────────────────────
  {
    id: 'architecture',
    topic: 'architecture',
    difficulty: 'beginner',
    question: 'What is the purpose of separating frontend and backend?',
    options: [
      { value: 'a', label: 'Each layer can be developed, scaled, and maintained independently', correct: true },
      { value: 'b', label: 'It makes the code harder to understand', correct: false },
      { value: 'c', label: 'It requires more servers', correct: false },
      { value: 'd', label: 'It prevents using databases', correct: false }
    ]
  },
  {
    id: 'architecture_patterns',
    topic: 'architecture',
    difficulty: 'advanced',
    question: 'What is the MVC (Model-View-Controller) pattern?',
    options: [
      { value: 'a', label: 'Separates application into data (M), UI (V), and logic (C) layers', correct: true },
      { value: 'b', label: 'A way to write CSS faster', correct: false },
      { value: 'c', label: 'A JavaScript testing framework', correct: false },
      { value: 'd', label: 'A database management system', correct: false }
    ]
  }
];

const assessmentQuestionLimit = 8;
const coreQuestionIds = [
  'html_basics',
  'js_basics',
  'git_basics',
  'debugging',
  'apis',
  'testing',
  'architecture'
];

/**
 * Get a question by its ID.
 * @param {string} id - Question identifier
 * @returns {object|undefined} The question object
 */
function getQuestion(id) {
  return questions.find(q => q.id === id);
}

/**
 * Get questions by topic.
 * @param {string} topic - Topic name
 * @returns {object[]} Array of questions for that topic
 */
function getQuestionsByTopic(topic) {
  return questions.filter(q => q.topic === topic);
}

/**
 * Get questions by difficulty.
 * @param {string} difficulty - Difficulty level (beginner, intermediate, advanced)
 * @returns {object[]} Array of questions at that difficulty
 */
function getQuestionsByDifficulty(difficulty) {
  return questions.filter(q => q.difficulty === difficulty);
}

/**
 * Get the next question based on previous answers.
 * Uses adaptive logic:
 * - If foundational answers are wrong, offer more foundational questions
 * - If JavaScript answers are wrong, offer more JS questions
 * - Otherwise, follow the standard flow
 *
 * @param {object} answers - Map of questionId → selectedValue
 * @returns {object|null} Next question or null if assessment complete
 */
function getNextQuestion(answers) {
  for (const id of coreQuestionIds) {
    if (!answers[id]) return getQuestion(id);
  }

  const coreCorrect = coreQuestionIds.reduce((total, id) => {
    const question = getQuestion(id);
    return total + (question.options.some(option => option.value === answers[id] && option.correct) ? 1 : 0);
  }, 0);
  const adaptiveId = coreCorrect >= 6
    ? 'architecture_patterns'
    : coreCorrect >= 3
      ? 'js_basics_advanced'
      : 'css_box_model';

  if (!answers[adaptiveId]) return getQuestion(adaptiveId);

  return null; // All questions answered
}

/**
 * Score the assessment based on answers.
 * Each correct answer = 1 point toward the total.
 *
 * Levels (for the eight-question diagnostic):
 * - foundation: 0-2 correct (new to software engineering)
 * - builder: 3-5 correct (working knowledge)
 * - professional: 6-8 correct (experienced)
 *
 * @param {object} answers - Map of questionId → selectedValue
 * @returns {{ level: string, score: number, topicScores: object, answers: object }}
 */
function scoreAssessment(answers) {
  let score = 0;
  const topicScores = {};

  for (const q of questions) {
    const answer = answers[q.id];
    if (!answer) continue;
    const isCorrect = answer && q.options.find(o => o.value === answer)?.correct;

    if (!topicScores[q.topic]) {
      topicScores[q.topic] = { correct: 0, total: 0 };
    }
    topicScores[q.topic].total++;

    if (isCorrect) {
      score++;
      topicScores[q.topic].correct++;
    }
  }

  let level;
  if (score <= 2) {
    level = 'foundation';
  } else if (score <= 5) {
    level = 'builder';
  } else {
    level = 'professional';
  }

  return { level, score, topicScores, answers };
}

module.exports = {
  getQuestion,
  getQuestionsByTopic,
  getQuestionsByDifficulty,
  getNextQuestion,
  scoreAssessment,
  questions,
  assessmentQuestionLimit
};
