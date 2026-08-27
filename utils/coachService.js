const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Normalize a coach response from Gemini JSON.
 * Trims each field to 500 characters max.
 */
function normalizeCoachResponse(json) {
  return {
    acknowledgement: (json.acknowledgement || '').slice(0, 500),
    insight: (json.insight || '').slice(0, 500),
    nextAction: (json.next_action || json.nextAction || '').slice(0, 500),
    isFallback: false
  };
}

/**
 * Create a fallback coach response when AI fails.
 * Names the next task to keep the learner moving.
 */
function createFallbackCoachResponse(nextTask) {
  const taskName = nextTask ? nextTask.task : 'your next learning activity';
  return {
    acknowledgement: 'Thanks for checking in! Keep up the momentum.',
    insight: 'Consistency is key to building new skills. Every day you show up counts.',
    nextAction: `Next up: ${taskName}. You've got this!`,
    isFallback: true
  };
}

/**
 * Get level-specific coaching context for the prompt.
 */
function getLevelContext(level, topicScores) {
  const contexts = {
    foundation: {
      tone: 'extraordinarily patient, encouraging, and reassuring',
      focus: 'building confidence, mastering fundamentals, avoiding overwhelm',
      avoid: 'jargon, advanced concepts, rushing through topics',
      emphasis: 'Every small step matters. You\'re building a solid foundation that will serve you forever.',
      typicalChallenge: 'feeling overwhelmed by how much there is to learn',
      milestoneMessage: 'You\'re laying the groundwork — this is where lasting skills are built.'
    },
    builder: {
      tone: 'supportive but pushing for deeper understanding',
      focus: 'bridging theory to practice, real-world projects, filling knowledge gaps',
      avoid: 'being too basic, skipping over fundamentals they haven\'t mastered',
      emphasis: 'You have the basics down — now it\'s about applying them to real problems.',
      typicalChallenge: 'knowing syntax but struggling with architecture or debugging',
      milestoneMessage: 'You\'re past the basics — now you\'re building real things.'
    },
    professional: {
      tone: 'respectful of existing knowledge, focused on refinement',
      focus: 'best practices, architecture decisions, code quality, mentoring others',
      avoid: 'being too introductory, hand-holding on basics',
      emphasis: 'You know the fundamentals — let\'s sharpen your edge and expand your impact.',
      typicalChallenge: 'knowing what to learn next or how to structure larger projects',
      milestoneMessage: 'You\'re operating at a professional level — time to lead and innovate.'
    }
  };
  return contexts[level] || contexts.builder;
}

/**
 * Analyze topic strengths and weaknesses from topic scores.
 */
function analyzeTopicScores(topicScores) {
  if (!topicScores || Object.keys(topicScores).length === 0) {
    return { strengths: [], weaknesses: [], message: 'No topic data available.' };
  }

  const topics = Object.entries(topicScores).map(([topic, scores]) => ({
    topic,
    percentage: scores.total > 0 ? Math.round((scores.correct / scores.total) * 100) : 0
  }));

  const strengths = topics.filter(t => t.percentage >= 75).map(t => t.topic);
  const weaknesses = topics.filter(t => t.percentage < 50).map(t => t.topic);

  let message = '';
  if (strengths.length > 0) {
    message += `Strong areas: ${strengths.join(', ')}. `;
  }
  if (weaknesses.length > 0) {
    message += `Areas to focus on: ${weaknesses.join(', ')}.`;
  }

  return { strengths, weaknesses, message };
}

/**
 * Generate a coach response using Gemini.
 * Returns validated response or fallback on any error.
 *
 * The prompt adapts based on:
 * - Learner level (foundation/builder/professional)
 * - Topic strengths and weaknesses
 * - Goal alignment
 * - Check-in notes quality
 * - Weekly project context
 */
async function createCoachResponse(context) {
  const {
    profile,
    goal,
    completedTask,
    checkinNotes,
    weeklyProject,
    nextTask
  } = context;

  const level = profile?.level || 'builder';
  const levelContext = getLevelContext(level, profile?.topicScores);
  const topicAnalysis = analyzeTopicScores(profile?.topicScores);

  // Analyze check-in notes quality
  const notesLength = checkinNotes ? checkinNotes.trim().length : 0;
  const hasDetailedNotes = notesLength > 50;
  const hasMinimalNotes = notesLength > 0 && notesLength < 30;

  try {
    const prompt = `You are an expert software engineering coach with years of teaching experience. A learner just completed a check-in.

═══ LEARNER PROFILE ═══
Level: ${level.toUpperCase()}
${levelContext.emphasis}

Goal: ${goal || 'Not specified yet'}
Topic Analysis: ${topicAnalysis.message || 'No topic data'}

═══ TODAY'S PROGRESS ═══
Completed: ${completedTask?.task || 'a learning task'}
Weekly Project: ${weeklyProject || 'None specified'}
Next Up: ${nextTask?.task || 'Upcoming learning activity'}

═══ CHECK-IN NOTES ═══
"${checkinNotes || 'No notes provided'}"
${hasDetailedNotes ? '(Learner provided detailed notes — acknowledge their reflection!)' : ''}
${hasMinimalNotes ? '(Notes are brief — gently encourage more detail next time)' : ''}

═══ YOUR COACHING STYLE ═══
- Tone: ${levelContext.tone}
- Focus on: ${levelContext.focus}
- Avoid: ${levelContext.avoid}
- Remember: ${levelContext.typicalChallenge} is common at this stage

═══ RESPONSE FORMAT ═══
Respond with ONLY valid JSON (no markdown, no code blocks, no explanation):
{
  "acknowledgement": "Warm, specific acknowledgment of what they accomplished. Reference their actual notes when possible. 1-2 sentences.",
  "insight": "One actionable insight tailored to their level and weak areas. Be specific — not generic advice. 2-3 sentences.",
  "next_action": "Clear, motivating next step that connects what they just did to what's coming. 1-2 sentences."
}

═══ IMPORTANT ═══
- Reference their actual work and notes — don't be generic
- For FOUNDATION: Celebrate every win, no matter how small. Reassure them.
- For BUILDER: Push them to apply concepts to real problems.
- For PROFESSIONAL: Challenge them with deeper thinking, not basics.
- Never be condescending at any level.
- If they mentioned struggles, address them directly with practical advice.`;

    const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    const cleaned = responseText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return normalizeCoachResponse(parsed);
  } catch (err) {
    console.error('Coach response generation failed:', err.message);
    return createFallbackCoachResponse(nextTask);
  }
}

module.exports = {
  createCoachResponse,
  normalizeCoachResponse,
  createFallbackCoachResponse,
  getLevelContext,
  analyzeTopicScores
};
