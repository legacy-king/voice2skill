/**
 * Matches a free-form goal ("I want to learn X") to the closest skill track.
 *
 * Scoring: each keyword hit adds points (multi-word phrases score higher),
 * matched on word boundaries so "web" doesn't match "website" accidentally
 * (well — "website" SHOULD map to Web Development, so it has its own keyword).
 * Returns the track object with the highest score, or null if nothing matched.
 */

const KEYWORDS = {
  'Web Development': [
    'web development', 'front end', 'frontend', 'back end', 'backend',
    'full stack', 'fullstack', 'web', 'html', 'css', 'javascript', 'js',
    'react', 'node', 'developer', 'software', 'coding', 'programming',
    'code', 'build websites', 'website', 'api', 'app', 'apps'
  ],
  'UI/UX Design': [
    'ui/ux', 'ui ux', 'ux design', 'ui design', 'design', 'figma',
    'user interface', 'interface', 'user experience', 'prototype', 'wireframe',
    'product design', 'graphic design', 'mobile app design', 'mobile app', 'app design'
  ],
  'Data Analysis': [
    'data analysis', 'data analytics', 'analytics', 'data science', 'data',
    'sql', 'excel', 'spreadsheet', 'python', 'statistics', 'visualization',
    'power bi', 'tableau', 'pandas', 'pivot table', 'dashboards'
  ],
  'Digital Marketing': [
    'digital marketing', 'marketing', 'seo', 'social media', 'content',
    'copywriting', 'growth', 'ads', 'advertising', 'google ads', 'branding',
    'email marketing', 'instagram', 'tiktok'
  ],
  'Cybersecurity': [
    'cybersecurity', 'cyber security', 'security', 'hacking', 'hacker',
    'ethical hacking', 'penetration', 'infosec', 'network security',
    'threat', 'vulnerability', 'privacy', 'defensive security'
  ]
};

/** Escape regex special chars so keywords match literally. */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True if the keyword appears in the goal on word boundaries. */
function hasKeyword(goal, keyword) {
  const re = new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'i');
  return re.test(goal);
}

/** Levenshtein edit distance — small for typos like "pythin" vs "python". */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** Max edit distance tolerated for a keyword of a given length. */
function fuzzyThreshold(keywordLength) {
  if (keywordLength >= 6) return 2;
  if (keywordLength >= 4) return 1;
  return 0; // short words (js, ui, api) must match exactly
}

/** True if any goal word is within edit distance of the keyword (typo-tolerant). */
function fuzzyMatches(goalWords, keyword) {
  const threshold = fuzzyThreshold(keyword.length);
  if (threshold === 0) return false;
  for (const word of goalWords) {
    if (Math.abs(word.length - keyword.length) > threshold) continue;
    if (levenshtein(word, keyword) <= threshold) return true;
  }
  return false;
}

/**
 * Score of one track for a goal. Phrases 2 pts, single words 1 pt,
 * fuzzy (typo) single-word hits 1 pt. `exact` counts exact (non-fuzzy)
 * hits so exact matches beat typo matches when points are equal.
 */
function scoreTrack(goal, goalWords, trackName) {
  const keywords = KEYWORDS[trackName] || [];
  let points = 0;
  let exact = 0;
  let distinct = 0;
  for (const kw of keywords) {
    if (hasKeyword(goal, kw)) {
      points += kw.includes(' ') ? 2 : 1;
      exact += 1;
      distinct += 1;
    } else if (!kw.includes(' ') && fuzzyMatches(goalWords, kw)) {
      points += 1;
      distinct += 1;
    }
  }
  return { points, exact, distinct };
}

/**
 * Rank every track against a goal, best first.
 *
 * @param {string} goal Free-form text, e.g. "I want to learn how to build websites"
 * @param {Array<{id:number,name:string}>} tracks The available tracks
 * @returns {Array<{track:object, points:number, exact:number, distinct:number}>}
 *   All tracks with a score > 0, sorted best-first (only tracks with points).
 */
function rankTracksForGoal(goal, tracks) {
  if (!goal || !goal.trim() || !Array.isArray(tracks) || tracks.length === 0) {
    return [];
  }
  const text = goal.trim();
  const goalWords = text.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);

  const scored = tracks.map((track) => {
    const { points, exact, distinct } = scoreTrack(text, goalWords, track.name);
    return { track, points, exact, distinct };
  });

  return scored
    .filter((entry) => entry.points > 0)
    .sort(
      (a, b) =>
        b.points - a.points ||
        b.exact - a.exact ||
        b.distinct - a.distinct
    );
}

/**
 * @param {string} goal Free-form text, e.g. "I want to learn how to build websites"
 * @param {Array<{id:number,name:string}>} tracks The available tracks
 * @returns {object|null} The closest track, or null if nothing matched
 */
function matchTrackToGoal(goal, tracks) {
  const ranked = rankTracksForGoal(goal, tracks);
  return ranked.length > 0 ? ranked[0].track : null;
}

// Stop words stripped when turning a goal into a compact YouTube search phrase.
// Action verbs like "learn", "build", "make" are deliberately KEPT — they carry
// the intent ("learn build websites" is a better search than "websites").
const STOP_WORDS = new Set([
  'i', 'i\'m', 'im', 'me', 'my', 'you', 'your', 'want', 'to', 'how', 'do',
  'can', 'would', 'like', 'get', 'be', 'a', 'an', 'the', 'and', 'or', 'for',
  'with', 'about', 'on', 'in', 'of', 'at', 'from', 'that', 'this', 'it', 'is',
  'am', 'are', 'was', 'were', 'could', 'should', 'start', 'starting', 'begin',
  'beginner', 'as', 'up', 'out', 'into', 'some', 'any', 'really', 'very', 'just'
]);

/**
 * Turn a free-form goal into a compact search phrase for YouTube/video search,
 * keeping the original word order so the query reads naturally,
 * e.g. "I want to learn how to build websites" -> "learn build websites".
 *
 * @param {string} goal Free-form text
 * @param {number} maxWords Max words to keep (default 4)
 * @returns {string} Non-stop words in original order, space-joined
 */
function goalToSearchPhrase(goal, maxWords = 4) {
  if (!goal) return '';
  const words = goal
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
  return words.slice(0, maxWords).join(' ');
}

module.exports = { matchTrackToGoal, rankTracksForGoal, goalToSearchPhrase };
