/**
 * LLM router configuration (services/llm.js). Providers, models and route order live here and can
 * be overridden by env vars, so changing a model or the failover order is a config change.
 *
 * Privacy rule (PLAN D1): a task that carries student text (check-in notes, mentor chat, goals)
 * may only use providers with `studentText: true`, i.e. providers that do not train on prompts:
 *   - groq:    Zero Data Retention must be ON in the Groq console (Data Controls).
 *   - gemini:  the PAID tier only (billing on for the project behind the key).
 *   - mistral: only once training is switched off in the Mistral console; set MISTRAL_NO_TRAINING=1.
 *   - openrouter: never for student text; only for Course Library generation (no personal data).
 * Adding a provider for student text also means naming it in views/privacy.ejs.
 *
 * Env overrides (all optional):
 *   LLM_ROUTE_<TASK>=groq,gemini        route order for a task (unknown names are ignored)
 *   LLM_MODEL_<PROVIDER>=...            model for a provider
 *   LLM_MODEL_<PROVIDER>_<TASK>=...     model for one provider on one task
 *   LLM_BASEURL_<PROVIDER>=...          base URL (tests point these at a mock server)
 *   LLM_TIMEOUT_MS (default 20000)      per-attempt timeout for chat tasks
 *   LLM_TIMEOUT_<TASK>_MS, LLM_MAX_TOKENS_<TASK>
 * Tasks: mentor, checkin, roadmap, course, stt (speech-to-text; Whisper on Groq by default).
 * Compatibility: GEMINI_API_KEY works as GEMINI_KEY; MENTOR_MODEL sets the Gemini mentor model.
 */

const PROVIDERS = {
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    keyEnv: ['GROQ_KEY'],
    studentText: () => true,
    jsonSchema: true,
    stt: 'whisper' // OpenAI-compatible /audio/transcriptions
  },
  gemini: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-3.6-flash',
    keyEnv: ['GEMINI_KEY', 'GEMINI_API_KEY'],
    studentText: () => true,
    jsonSchema: true,
    stt: 'chat_audio' // audio sent as an input_audio part to chat completions
  },
  mistral: {
    baseURL: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    keyEnv: ['MISTRAL_KEY'],
    studentText: () => process.env.MISTRAL_NO_TRAINING === '1',
    jsonSchema: true,
    stt: 'whisper' // Voxtral via /audio/transcriptions
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    model: null, // a current ":free" model must be chosen explicitly: LLM_MODEL_OPENROUTER
    keyEnv: ['OPENROUTER_KEY'],
    studentText: () => false,
    jsonSchema: false
  }
};

const TASKS = {
  // Low-latency chat. Mentor replies stream.
  mentor: { route: ['groq', 'gemini', 'mistral'], studentText: true, timeoutMs: null, maxTokens: 700, temperature: 0.4 },
  checkin: { route: ['groq', 'gemini', 'mistral'], studentText: true, timeoutMs: null, maxTokens: 600, temperature: 0.5 },
  // Per-user plan (rollout fallback until the Course Library is published). Carries the goal.
  roadmap: { route: ['gemini', 'mistral', 'groq'], studentText: true, timeoutMs: 120000, maxTokens: 60000, temperature: 0.5 },
  // Course Library weeks: shared content, no personal data.
  course: { route: ['gemini', 'mistral', 'groq', 'openrouter'], studentText: false, timeoutMs: 120000, maxTokens: 16000, temperature: 0.5 },
  // Speech-to-text for voice input. A voice clip is personal data, so the student-text rule applies.
  stt: {
    route: ['groq', 'gemini'], studentText: true, timeoutMs: 30000, maxTokens: 1000, temperature: 0,
    audio: true,
    models: { groq: 'whisper-large-v3-turbo', mistral: 'voxtral-mini-latest' }
  }
};

const env = (name) => {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};
const num = (name) => {
  const n = Number(env(name));
  return Number.isFinite(n) && n > 0 ? n : null;
};

function providerKey(name) {
  for (const k of PROVIDERS[name].keyEnv) if (env(k)) return env(k);
  return null;
}

function providerModel(name, task) {
  const P = name.toUpperCase();
  const T = task.toUpperCase();
  if (name === 'gemini' && task === 'mentor' && env('MENTOR_MODEL') && !env(`LLM_MODEL_${P}_${T}`)) return env('MENTOR_MODEL');
  const taskDefault = TASKS[task].models && TASKS[task].models[name];
  // A task with its own default model (e.g. Whisper for stt) ignores the provider-wide override.
  return env(`LLM_MODEL_${P}_${T}`) || taskDefault || env(`LLM_MODEL_${P}`) || PROVIDERS[name].model;
}

/** Resolved settings for one task, read from env on every call (cheap; lets tests change env). */
function taskConfig(task) {
  const t = TASKS[task];
  if (!t) throw new Error(`unknown LLM task "${task}"`);
  const T = task.toUpperCase();
  const route = (env(`LLM_ROUTE_${T}`) ? env(`LLM_ROUTE_${T}`).split(',').map((s) => s.trim().toLowerCase()) : t.route)
    .filter((name, i, all) => PROVIDERS[name] && all.indexOf(name) === i);

  const providers = [];
  const skipped = [];
  for (const name of route) {
    const p = PROVIDERS[name];
    const apiKey = providerKey(name);
    const model = providerModel(name, task);
    if (t.studentText && !p.studentText()) { skipped.push(`${name}:privacy`); continue; }
    if (t.audio && !p.stt) { skipped.push(`${name}:no_audio`); continue; }
    if (!apiKey) { skipped.push(`${name}:no_key`); continue; }
    if (!model) { skipped.push(`${name}:no_model`); continue; }
    providers.push({
      name,
      apiKey,
      model,
      baseURL: env(`LLM_BASEURL_${name.toUpperCase()}`) || p.baseURL,
      jsonSchema: p.jsonSchema,
      stt: p.stt || null
    });
  }
  return {
    task,
    providers,
    skipped,
    studentText: t.studentText,
    timeoutMs: num(`LLM_TIMEOUT_${T}_MS`) || t.timeoutMs || num('LLM_TIMEOUT_MS') || 20000,
    maxTokens: num(`LLM_MAX_TOKENS_${T}`) || t.maxTokens,
    temperature: t.temperature
  };
}

module.exports = { PROVIDERS, TASKS, taskConfig };
