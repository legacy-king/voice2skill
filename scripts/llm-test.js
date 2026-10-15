#!/usr/bin/env node
/**
 * LLM router tests (services/llm.js) against mock OpenAI-compatible providers.
 * No database, no network, no keys, no cost.
 *
 * Usage: npm run test:llm
 */
// Never let a real key from .env leak into this run (dotenv does not override set vars).
for (const k of ['GROQ_KEY', 'GEMINI_KEY', 'GEMINI_API_KEY', 'MISTRAL_KEY', 'OPENROUTER_KEY', 'MISTRAL_NO_TRAINING', 'MENTOR_MODEL']) process.env[k] = '';
for (const k of Object.keys(process.env)) if (/^LLM_/.test(k)) delete process.env[k];

const { z } = require('zod');
const { startMockLlm } = require('./mockLlmServer');
const llm = require('../services/llm');

let passed = 0, failed = 0;
function check(label, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} ${extra}`); }
}

const logs = [];
llm.setLogger(async (row) => { logs.push(row); });

async function main() {
  const mock = await startMockLlm();
  const setKeys = (names) => {
    for (const n of ['groq', 'gemini', 'mistral', 'openrouter']) {
      process.env[`LLM_BASEURL_${n.toUpperCase()}`] = mock.url(n);
    }
    process.env.GROQ_KEY = names.includes('groq') ? 'k-groq' : '';
    process.env.GEMINI_KEY = names.includes('gemini') ? 'k-gemini' : '';
    process.env.MISTRAL_KEY = names.includes('mistral') ? 'k-mistral' : '';
    process.env.OPENROUTER_KEY = names.includes('openrouter') ? 'k-or' : '';
  };
  const fresh = () => { mock.reset(); logs.length = 0; };
  const chat = (extra = {}) => llm.complete({ task: 'mentor', system: 'You are a mentor.', messages: [{ role: 'user', content: 'What is a closure?' }], userId: 7, ...extra });
  const hit = () => mock.requests.map((r) => r.provider).join(',');

  try {
    setKeys(['groq', 'gemini', 'mistral', 'openrouter']);
    process.env.LLM_TIMEOUT_MS = '400';

    console.log('Routing');
    fresh();
    let r = await chat();
    check('mentor goes to Groq first', r.provider === 'groq' && /\[mock mentor\]/.test(r.text) && hit() === 'groq');
    check('one log row: provider, model, task, latency, tokens, ok', logs.length === 1 && logs[0].provider === 'groq' && logs[0].model === 'openai/gpt-oss-120b'
      && logs[0].task === 'mentor' && logs[0].ok === true && logs[0].promptTokens === 11 && logs[0].completionTokens === 7 && logs[0].userId === 7 && Number.isInteger(logs[0].latencyMs));
    check('the log row holds no prompt or reply text', !JSON.stringify(logs).includes('closure') && !JSON.stringify(logs).includes('mock mentor'));
    check('system prompt sent as system, student text as user', mock.requests[0].body.messages[0].role === 'system' && mock.requests[0].body.messages[1].role === 'user');
    check('provider key sent as bearer token', mock.requests[0].auth === 'Bearer k-groq');

    fresh();
    process.env.LLM_ROUTE_MENTOR = 'gemini,groq';
    r = await chat();
    check('route order comes from config (LLM_ROUTE_MENTOR)', r.provider === 'gemini' && hit() === 'gemini');
    delete process.env.LLM_ROUTE_MENTOR;

    fresh();
    process.env.LLM_MODEL_GROQ = 'llama-test';
    await chat();
    check('model comes from config (LLM_MODEL_GROQ)', mock.requests[0].body.model === 'llama-test');
    delete process.env.LLM_MODEL_GROQ;
    fresh();
    process.env.MENTOR_MODEL = 'gemini-mentor-old';
    process.env.LLM_ROUTE_MENTOR = 'gemini';
    await chat();
    check('MENTOR_MODEL still sets the Gemini mentor model', mock.requests[0].body.model === 'gemini-mentor-old');
    process.env.MENTOR_MODEL = '';
    delete process.env.LLM_ROUTE_MENTOR;

    console.log('Failover');
    for (const mode of ['429', '500', '503', 'timeout']) {
      fresh();
      mock.setMode('groq', mode);
      r = await chat();
      const code = mode === 'timeout' ? 'timeout' : mode;
      check(`Groq ${mode} => fails over to Gemini`, r.provider === 'gemini' && hit() === 'groq,gemini');
      check(`  logged as failed (${code}) then ok`, logs.length === 2 && logs[0].ok === false && logs[0].errorCode === code && logs[1].ok === true, JSON.stringify(logs));
    }

    for (const mode of ['400', '401', '404']) {
      fresh();
      mock.setMode('groq', mode);
      const err = await chat().then(() => null, (e) => e);
      check(`Groq ${mode} => no failover (fails fast)`, err instanceof llm.LlmRequestError && hit() === 'groq' && logs.length === 1 && logs[0].errorCode === mode);
    }

    fresh();
    for (const p of ['groq', 'gemini']) mock.setMode(p, '429');
    mock.setMode('mistral', '500');
    process.env.MISTRAL_NO_TRAINING = '1';
    const all = await chat().then(() => null, (e) => e);
    check('every provider down => LlmUnavailableError with a friendly message', all instanceof llm.LlmUnavailableError && /try again/.test(all.userMessage) && hit() === 'groq,gemini,mistral');
    check('  three failed log rows', logs.length === 3 && logs.every((l) => !l.ok));
    process.env.MISTRAL_NO_TRAINING = '';

    console.log('Privacy');
    fresh();
    mock.setMode('groq', '500');
    mock.setMode('gemini', '500');
    await chat().catch(() => {});
    check('Mistral is skipped for student text until training is switched off', !hit().includes('mistral'));
    fresh();
    process.env.LLM_ROUTE_MENTOR = 'openrouter,groq';
    process.env.LLM_MODEL_OPENROUTER = 'some/model:free';
    r = await chat();
    check('OpenRouter is never used for student text', r.provider === 'groq' && hit() === 'groq');
    delete process.env.LLM_ROUTE_MENTOR;
    fresh();
    mock.setMode('gemini', '500'); mock.setMode('mistral', '500'); mock.setMode('groq', '500');
    r = await llm.complete({ task: 'course', system: 's', messages: [{ role: 'user', content: 'Return JSON.' }], validate: (d) => d });
    check('OpenRouter is allowed for Course Library (no personal data)', r.provider === 'openrouter' && hit() === 'gemini,mistral,groq,openrouter');
    check('  and gets json_object (no schema support declared)', mock.requests[3].body.response_format.type === 'json_object');
    delete process.env.LLM_MODEL_OPENROUTER;

    fresh();
    process.env.GROQ_KEY = '';
    r = await chat();
    check('a provider without a key is skipped (no request)', r.provider === 'gemini' && hit() === 'gemini');
    process.env.GROQ_KEY = 'k-groq';

    fresh();
    await chat({ messages: [{ role: 'user', content: 'mail me at ada.l@example.com or call +234 803 123 4567 / 08031234567' }] });
    const sent = mock.requests[0].body.messages[1].content;
    check('emails and phone numbers are redacted from student text', !/example\.com|803|0803/.test(sent) && /\[email\]/.test(sent) && /\[phone\]/.test(sent), sent);
    fresh();
    await chat({ messages: [{ role: 'user', content: 'const total = items.length * 3; // 2026-10-15' }] });
    check('ordinary code and dates are not redacted', mock.requests[0].body.messages[1].content.includes('2026-10-15') && mock.requests[0].body.messages[1].content.includes('items.length * 3'));

    console.log('JSON tasks');
    const Coach = z.object({ acknowledgement: z.string().min(1), insight: z.string().min(1), next_action: z.string().min(1) });
    fresh();
    r = await llm.complete({ task: 'checkin', system: 's', messages: [{ role: 'user', content: 'notes' }], schema: Coach });
    check('JSON reply parsed and validated with zod', r.data && /mock coach:groq/.test(r.data.acknowledgement));
    check('  json_schema response_format sent (derived from zod, $schema stripped)', mock.requests[0].body.response_format.type === 'json_schema'
      && !JSON.stringify(mock.requests[0].body.response_format).includes('$schema'));
    fresh();
    mock.setMode('groq', 'badjson');
    r = await llm.complete({ task: 'checkin', system: 's', messages: [{ role: 'user', content: 'notes' }], schema: Coach });
    check('invalid JSON => fails over', r.provider === 'gemini' && logs[0].errorCode === 'invalid_json');
    fresh();
    mock.setResponder('groq', () => JSON.stringify({ acknowledgement: 'only one field' }));
    r = await llm.complete({ task: 'checkin', system: 's', messages: [{ role: 'user', content: 'notes' }], schema: Coach });
    check('JSON that fails the schema => fails over', r.provider === 'gemini' && logs[0].errorCode === 'invalid_schema');

    console.log('Streaming');
    fresh();
    let deltas = [];
    r = await llm.stream({ task: 'mentor', system: 's', messages: [{ role: 'user', content: 'stream please' }], userId: 3, onDelta: (d) => deltas.push(d) });
    check('stream delivers chunks that add up to the reply', deltas.length > 1 && deltas.join('').trim() === r.text && /stream please/.test(r.text));
    check('  logged as streamed with token usage', logs.length === 1 && logs[0].streamed === true && logs[0].ok && logs[0].completionTokens === 7);
    fresh();
    deltas = [];
    mock.setMode('groq', '429');
    r = await llm.stream({ task: 'mentor', system: 's', messages: [{ role: 'user', content: 'x' }], onDelta: (d) => deltas.push(d) });
    check('stream fails over before the first token', r.provider === 'gemini' && deltas.join('').trim() === r.text);
    fresh();
    mock.setMode('groq', 'timeout');
    r = await llm.stream({ task: 'mentor', system: 's', messages: [{ role: 'user', content: 'x' }], onDelta: () => {} });
    check('stream timeout fails over', r.provider === 'gemini' && logs[0].errorCode === 'timeout');

    console.log('Speech-to-text');
    const clip = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000, 7)]);
    fresh();
    r = await llm.transcribe({ audio: clip, mime: 'audio/webm', userId: 5 });
    const sttReq = mock.requests[0];
    check('Groq Whisper transcribes first', r.provider === 'groq' && r.text === '[mock transcript:groq]' && sttReq.kind === 'transcription');
    check('  multipart upload with whisper-large-v3-turbo and the audio bytes', /multipart\/form-data/.test(sttReq.contentType)
      && sttReq.raw.includes('whisper-large-v3-turbo') && sttReq.raw.includes('clip.webm') && sttReq.raw.includes(clip));
    check('  logged as task stt, no audio in the log', logs.length === 1 && logs[0].task === 'stt' && logs[0].ok && logs[0].userId === 5 && JSON.stringify(logs).length < 400);
    fresh();
    mock.setMode('groq', '503');
    r = await llm.transcribe({ audio: clip, mime: 'audio/webm' });
    const gReq = mock.requests[1];
    const part = gReq.body.messages[1].content[0];
    check('Groq down => Gemini transcribes from an input_audio part', r.provider === 'gemini' && r.text === '[mock transcript:gemini]'
      && part.type === 'input_audio' && part.input_audio.format === 'webm' && part.input_audio.data === clip.toString('base64'));
    fresh();
    mock.setMode('groq', '400');
    check('STT 400 fails fast', await llm.transcribe({ audio: clip, mime: 'audio/webm' }).then(() => false, (e) => e instanceof llm.LlmRequestError) && hit() === 'groq');
    fresh();
    mock.setTranscript('groq', '');
    r = await llm.transcribe({ audio: clip, mime: 'audio/ogg' });
    check('silence returns an empty transcript (no failover)', r.text === '' && hit() === 'groq');
    check('unsupported audio type is refused before any request', await llm.transcribe({ audio: clip, mime: 'audio/wav' }).then(() => false, () => true));
    fresh();
    process.env.LLM_ROUTE_STT = 'openrouter,groq';
    process.env.LLM_MODEL_OPENROUTER = 'x:free';
    r = await llm.transcribe({ audio: clip, mime: 'audio/mp4' });
    check('providers without audio support or student-text clearance are skipped', r.provider === 'groq' && hit() === 'groq');
    check('  mp4 clips are sent as clip.mp4', mock.requests[0].raw.includes('clip.mp4'));
    delete process.env.LLM_ROUTE_STT;
    delete process.env.LLM_MODEL_OPENROUTER;
    fresh();
    process.env.LLM_MODEL_GROQ = 'llama-for-chat';
    await llm.transcribe({ audio: clip, mime: 'audio/webm' });
    check('a chat model override does not replace the Whisper model', mock.requests[0].raw.includes('whisper-large-v3-turbo'));
    delete process.env.LLM_MODEL_GROQ;
  } finally {
    await mock.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('TEST CRASHED:', err); process.exit(1); });
