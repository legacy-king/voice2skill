const { GoogleGenerativeAI } = require('@google/generative-ai');
const roadmapModel = require('../models/roadmapModel');
const trackModel = require('../models/trackModel');
const checkinModel = require('../models/checkinModel');

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
      "daily_topics": ["topic 1", "topic 2", "topic 3", "topic 4", "topic 5"]
    }
  ]
}

Include free, real, reputable resources (freeCodeCamp, MDN, official docs) mentioned briefly within daily_topics where relevant. Return ONLY the JSON, nothing else.`;

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

  res.render('roadmap', { roadmap, checkins });
}

module.exports = { generateRoadmapContent, selectTrack, getRoadmap };