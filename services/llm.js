/**
 * LLM router: every AI text call in the app goes through here (PLAN Phase 1).
 *
 *   complete({ task, system, messages, schema | jsonSchema | validate, userId })  -> { text, data, provider, model }
 *   stream({ task, system, messages, userId, onDelta })                          -> { text, provider, model }
 *
 * - Providers are OpenAI-compatible endpoints (openai SDK with a per-provider baseURL); routes,
 *   models and timeouts come from config/llm.js.
 * - Fails over to the next provider ONLY on 429, 5xx, timeout or network error (and on a reply
 *   that isn't the JSON we asked for). Other 4xx (bad request, auth) stop immediately: a bad
 *   prompt must not burn every quota. A stream only fails over before its first token.
 * - One llm_calls row per attempt: provider, model, task, latency, tokens, ok, error code.
 *   Prompt and reply text are never logged.
 * - Privacy: tasks that carry student text only use providers allowed for it (config), student
 *   text belongs in `messages` (user turns), never in `system`, and emails/phone numbers are
 *   redacted from user turns as a backstop. Callers pass ids, never names or emails.
 * - When every provider fails, throws LlmUnavailableError; callers show their friendly fallback.
 */
const OpenAI = require('openai');
const { taskConfig } = require('../config/llm');

class LlmUnavailableError extends Error {
  constructor(task, attempts) {
    super(`All LLM providers failed for "${task}": ${attempts.map((a) => `${a.provider}=${a.code}`).join(', ') || 'none configured'}`);
    this.name = 'LlmUnavailableError';
    this.task = task;
    this.attempts = attempts;
    this.userMessage = 'Our AI is busy right now. Please try again in a few minutes.';
  }
}

class LlmRequestError extends Error {
  constructor(task, provider, code, message) {
    super(`LLM request for "${task}" rejected by ${provider} (${code}): ${message}`);
    this.name = 'LlmRequestError';
    this.code = code;
  }
}

// ---- redaction (backstop; callers must not send personal details in the first place) ----
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?<![\w])(?:\+\d{1,3}[\s-]?)?\(?0?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}(?![\w])/g;
function redact(text) {
  return String(text).replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[phone]');
}

// ---- call log ----
let logger = async (row) => {
  const pool = require('../config/db');
  await pool.query(
    `INSERT INTO llm_calls (provider, model, task, streamed, latency_ms, prompt_tokens, completion_tokens, ok, error_code, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [row.provider, row.model, row.task, row.streamed, row.latencyMs, row.promptTokens, row.completionTokens, row.ok, row.errorCode, row.userId]
  );
};
/** Tests swap the DB logger for an in-memory one. */
function setLogger(fn) { logger = fn; }
async function logCall(row) {
  try {
    await logger(row);
  } catch (err) {
    console.error('llm_calls log failed:', err.message);
  }
}

// ---- helpers ----
const clients = new Map();
function client(p) {
  const key = `${p.name}|${p.baseURL}|${p.apiKey}`;
  if (!clients.has(key)) clients.set(key, new OpenAI({ apiKey: p.apiKey, baseURL: p.baseURL, maxRetries: 0 }));
  return clients.get(key);
}

class AttemptError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** -> { code, failover } */
function classify(err, timedOut) {
  if (timedOut || err instanceof OpenAI.APIConnectionTimeoutError) return { code: 'timeout', failover: true };
  if (err instanceof AttemptError) return { code: err.code, failover: true };
  if (err instanceof OpenAI.APIError && err.status) {
    return { code: String(err.status), failover: err.status === 429 || err.status >= 500 };
  }
  if (err instanceof OpenAI.APIConnectionError || err instanceof OpenAI.APIUserAbortError) return { code: 'network', failover: true };
  return { code: 'error', failover: false };
}

/** JSON Schema without the bits OpenAI-compatible endpoints disagree on. */
function cleanSchema(node) {
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema' || k === 'additionalProperties' || k === '$id') continue;
    out[k] = cleanSchema(v);
  }
  return out;
}

function buildMessages(cfg, system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: String(system) });
  for (const m of messages || []) {
    if (m.role !== 'user' && m.role !== 'assistant') throw new Error(`invalid message role "${m.role}"`);
    out.push({ role: m.role, content: cfg.studentText && m.role === 'user' ? redact(m.content) : String(m.content) });
  }
  return out;
}

function parseJson(text) {
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new AttemptError('invalid_json', 'reply was not valid JSON');
  }
}

/**
 * Non-streaming completion.
 * JSON: pass `schema` (zod) and/or `jsonSchema` (plain JSON Schema for the provider) and/or
 * `validate(parsed)` (throw to reject). Any of them turns on JSON mode; a reply that fails them
 * counts as a failed attempt and moves on to the next provider.
 */
async function complete({ task, system, messages, schema, jsonSchema, validate, userId = null, maxTokens, temperature }) {
  const cfg = taskConfig(task);
  const wantsJson = !!(schema || jsonSchema || validate);
  const schemaForProvider = jsonSchema || (schema ? require('zod').toJSONSchema(schema) : null);
  const msgs = buildMessages(cfg, system, messages);
  const attempts = [];

  for (const p of cfg.providers) {
    const started = Date.now();
    let timedOut = false;
    const ac = new AbortController();
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, cfg.timeoutMs);
    try {
      const body = {
        model: p.model,
        messages: msgs,
        max_tokens: maxTokens || cfg.maxTokens,
        temperature: temperature ?? cfg.temperature
      };
      if (wantsJson) {
        body.response_format = schemaForProvider && p.jsonSchema
          ? { type: 'json_schema', json_schema: { name: 'response', schema: cleanSchema(schemaForProvider), strict: false } }
          : { type: 'json_object' };
      }
      const res = await client(p).chat.completions.create(body, { signal: ac.signal, timeout: cfg.timeoutMs });
      const choice = res.choices && res.choices[0];
      const text = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content.trim() : '';
      if (!text) throw new AttemptError('empty', 'empty reply');
      if (choice.finish_reason === 'length') throw new AttemptError('truncated', 'reply hit max_tokens');

      let data;
      if (wantsJson) {
        data = parseJson(text);
        if (schema) {
          const parsed = schema.safeParse(data);
          if (!parsed.success) throw new AttemptError('invalid_schema', parsed.error.message.slice(0, 200));
          data = parsed.data;
        }
        if (validate) {
          try { data = validate(data) ?? data; } catch (err) { throw new AttemptError('invalid_schema', err.message); }
        }
      }
      await logCall({
        provider: p.name, model: p.model, task, streamed: false, latencyMs: Date.now() - started,
        promptTokens: res.usage?.prompt_tokens ?? null, completionTokens: res.usage?.completion_tokens ?? null,
        ok: true, errorCode: null, userId
      });
      return { text, data, provider: p.name, model: p.model };
    } catch (err) {
      const { code, failover } = classify(err, timedOut);
      attempts.push({ provider: p.name, code });
      await logCall({
        provider: p.name, model: p.model, task, streamed: false, latencyMs: Date.now() - started,
        promptTokens: null, completionTokens: null, ok: false, errorCode: code, userId
      });
      if (!failover) throw new LlmRequestError(task, p.name, code, err.message);
      console.error(`LLM ${task}: ${p.name} failed (${code}), trying next provider`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new LlmUnavailableError(task, attempts);
}

/**
 * Streaming completion for chat tasks. `onDelta(text)` receives each chunk. Fails over only
 * before the first chunk; after that a failure is thrown (the caller can't un-show text).
 * The timeout is an idle timeout: it resets whenever a chunk arrives.
 */
async function stream({ task, system, messages, userId = null, onDelta, maxTokens, temperature }) {
  const cfg = taskConfig(task);
  const msgs = buildMessages(cfg, system, messages);
  const attempts = [];

  for (const p of cfg.providers) {
    const started = Date.now();
    let timedOut = false;
    let gotDelta = false;
    let text = '';
    let usage = null;
    const ac = new AbortController();
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; ac.abort(); }, cfg.timeoutMs);
    };
    arm();
    try {
      const res = await client(p).chat.completions.create({
        model: p.model,
        messages: msgs,
        max_tokens: maxTokens || cfg.maxTokens,
        temperature: temperature ?? cfg.temperature,
        stream: true,
        stream_options: { include_usage: true }
      }, { signal: ac.signal, timeout: cfg.timeoutMs });
      for await (const chunk of res) {
        arm();
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
        if (delta) {
          gotDelta = true;
          text += delta;
          await onDelta(delta);
        }
      }
      if (!text.trim()) throw new AttemptError('empty', 'empty reply');
      await logCall({
        provider: p.name, model: p.model, task, streamed: true, latencyMs: Date.now() - started,
        promptTokens: usage?.prompt_tokens ?? null, completionTokens: usage?.completion_tokens ?? null,
        ok: true, errorCode: null, userId
      });
      return { text: text.trim(), provider: p.name, model: p.model };
    } catch (err) {
      const { code, failover } = classify(err, timedOut);
      attempts.push({ provider: p.name, code });
      await logCall({
        provider: p.name, model: p.model, task, streamed: true, latencyMs: Date.now() - started,
        promptTokens: null, completionTokens: null, ok: false, errorCode: code, userId
      });
      if (gotDelta) throw new LlmUnavailableError(task, attempts); // already showing text: no silent switch
      if (!failover) throw new LlmRequestError(task, p.name, code, err.message);
      console.error(`LLM ${task} (stream): ${p.name} failed (${code}), trying next provider`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new LlmUnavailableError(task, attempts);
}

module.exports = { complete, stream, redact, setLogger, LlmUnavailableError, LlmRequestError };
