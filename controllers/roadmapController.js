const { GoogleGenerativeAI } = require('@google/generative-ai');
const roadmapModel = require('../models/roadmapModel');
const trackModel = require('../models/trackModel');
const checkinModel = require('../models/checkinModel');
const { calculateStreak } = require('../utils/streak');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function generateRoadmapContent(trackName, trackDescription) {
  const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

  const prompt = `You are a career coach creating a learning roadmap for someone starting "${trackName}" (${trackDescription}).

Generate an 8-week roadmap as valid JSON only, no markdown formatting, no explanation, matching this exact structure:
{
  "weeks": [
    {
      "week_number": 1,
      "focus": "short title for the week",
      "days": [
        {
          "day_number": 1,
          "task": "a clear, specific instruction for what to do today, written like a coach speaking directly to the learner (e.g. 'Today, learn HTML structure: tags, elements, and semantic markup')",
          "resource_name": "freeCodeCamp",
          "resource_url": "https://www.freecodecamp.org",
          "video_search_term": "a YouTube search phrase for someone who prefers video (e.g. 'HTML basics crash course')"
        }
      ]
    }
  ]
}

Each week must have exactly 5 days (Monday-Friday pace). Write each "task" as a direct, encouraging instruction, not just a topic label. Use only well-known, real platforms (freeCodeCamp, MDN Web Docs, official framework docs, W3Schools) for resource_url — root URLs only, not deep article links, since deep links can be inaccurate. For video_search_term, provide a search phrase, NOT a direct YouTube link (since we cannot verify a specific video exists). Return ONLY the JSON, nothing else.`;
  
const result = await model.generateContent(prompt);
  const responseText = result.response.text();

  const cleaned = responseText.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

async function selectTrack(req, res) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const userId = req.session.userId;
  const trackId = req.params.trackId;

  const existingRoadmap = await roadmapModel.getRoadmapByUserAndTrack(userId, trackId);
  if (existingRoadmap) {
    return res.redirect(`/roadmaps/${existingRoadmap.id}`);
  }

  const track = await trackModel.getTrackById(trackId);
  const content = await generateRoadmapContent(track.name, track.description);
  const newRoadmap = await roadmapModel.createRoadmap(userId, trackId, content);

  res.redirect(`/roadmaps/${newRoadmap.id}`);
}

async function getRoadmap(req, res) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  const userId = req.session.userId;
  const roadmapId = req.params.id;

  const roadmap = await roadmapModel.getRoadmapById(roadmapId);
  const checkins = await checkinModel.getCheckinsByRoadmap(userId, roadmapId);
  const streak = calculateStreak(checkins);
  const message = req.query.message;

  res.render('roadmap', { roadmap, checkins, message, streak });
}

module.exports = { generateRoadmapContent, selectTrack, getRoadmap };