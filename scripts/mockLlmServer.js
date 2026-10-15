/**
 * Mock OpenAI-compatible LLM providers for tests (no network, no keys, no cost).
 * Each provider lives under its own path prefix: baseURL = http://127.0.0.1:<port>/<name>
 *
 *   const mock = await startMockLlm();            // mock.url('groq') -> base URL
 *   mock.setMode('groq', '429' | '500' | '400' | 'timeout' | 'badjson' | 'ok')
 *   mock.setResponder('groq', (body) => 'reply text')
 *   mock.requests                                  // [{ provider, body }]
 *
 * Default replies: JSON requests get a coach-shaped object; chat gets "[mock mentor] You asked: …".
 * Streams use SSE chunks like the real APIs, with a final usage chunk when asked for.
 */
const http = require('http');

function defaultReply(provider, body) {
  if (body.response_format) {
    return JSON.stringify({
      acknowledgement: `[mock coach:${provider}] Nice work today.`,
      insight: 'Keep notes short and specific.',
      next_action: 'Do the next task tomorrow.'
    });
  }
  const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
  const asked = lastUser ? String(lastUser.content).slice(0, 80) : '';
  return `[mock mentor] You asked: "${asked}". Next step: write down what you already know, then try one small example.`;
}

function startMockLlm({ port = 0 } = {}) {
  const modes = new Map();
  const responders = new Map();
  const requests = [];
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const m = req.url.match(/^\/([a-z]+)\/chat\/completions$/);
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!m || req.method !== 'POST') { res.writeHead(404); return res.end(); }
      const provider = m[1];
      let body = {};
      try { body = JSON.parse(raw); } catch { /* keep {} */ }
      requests.push({ provider, body, auth: req.headers.authorization });
      const mode = modes.get(provider) || 'ok';

      if (mode === 'timeout') return; // never answer; the client must give up
      if (/^\d{3}$/.test(mode)) {
        res.writeHead(Number(mode), { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `mock ${mode}`, type: 'mock' } }));
      }
      const text = mode === 'badjson' ? 'this is not json {' : (responders.get(provider) || ((b) => defaultReply(provider, b)))(body);
      const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };

      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const parts = text.match(/.{1,12}/gs) || [];
        for (const part of parts) {
          res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        if (body.stream_options && body.stream_options.include_usage) {
          res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [], usage })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage
      }));
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        url: (name) => `http://127.0.0.1:${actual}/${name}`,
        setMode: (name, mode) => modes.set(name, mode),
        setResponder: (name, fn) => (fn ? responders.set(name, fn) : responders.delete(name)),
        reset: () => { modes.clear(); responders.clear(); requests.length = 0; },
        requests,
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); })
      });
    });
  });
}

module.exports = { startMockLlm, defaultReply };
