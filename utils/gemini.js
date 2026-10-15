/**
 * One place to configure Gemini: model name, request timeout, JSON mode.
 * The API key stays on the server (read from GEMINI_API_KEY).
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

/**
 * @param {object} opts
 * @param {number} opts.timeoutMs abort the request after this long
 * @returns a GenerativeModel that asks for a JSON response
 */
function getJsonModel({ timeoutMs }) {
  return genAI.getGenerativeModel(
    { model: GEMINI_MODEL, generationConfig: { responseMimeType: 'application/json' } },
    { timeout: timeoutMs }
  );
}

/** Parse model text as JSON, tolerating stray ```json fences. Throws on bad JSON. */
function parseJsonResponse(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

module.exports = { getJsonModel, parseJsonResponse, GEMINI_MODEL };
