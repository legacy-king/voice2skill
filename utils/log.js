/**
 * Structured logs: one JSON object per line, e.g.
 *   {"time":"…","level":"error","msg":"Mentor reply failed: …","reqId":"…","userId":12}
 * Render keeps stdout/stderr, so these are searchable by reqId, userId or msg.
 *
 * log.info / log.warn / log.error take console-style arguments (strings are joined, an Error adds
 * its message and stack, a trailing plain object is merged in as fields), so replacing console.*
 * calls is mechanical. The request id and user id of the current request are added automatically
 * (AsyncLocalStorage set by requestContext()).
 *
 * Never log secrets, tokens, card data or request bodies. Request lines log the path WITHOUT the
 * query string, because email links carry tokens there.
 */
const crypto = require('crypto');
const util = require('util');
const { AsyncLocalStorage } = require('async_hooks');

const context = new AsyncLocalStorage();

function write(level, args) {
  const fields = {};
  const parts = [];
  args.forEach((a, i) => {
    if (a instanceof Error) {
      parts.push(a.message);
      fields.err = { name: a.name, message: a.message, stack: a.stack };
    } else if (i === args.length - 1 && a && typeof a === 'object' && !Array.isArray(a) && args.length > 1) {
      Object.assign(fields, a);
    } else {
      parts.push(typeof a === 'string' ? a : util.inspect(a, { depth: 3, breakLength: Infinity }));
    }
  });
  const ctx = context.getStore() || {};
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    msg: parts.join(' '),
    ...(ctx.reqId ? { reqId: ctx.reqId } : {}),
    ...(ctx.userId ? { userId: ctx.userId } : {}),
    ...fields
  });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

const log = {
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args)
};

/**
 * Express middleware: gives each request an id (X-Request-Id), runs the rest of the request
 * inside that context, and logs one line when the response finishes.
 */
function requestContext({ skip = () => false } = {}) {
  return function requestContextMiddleware(req, res, next) {
    const reqId = crypto.randomUUID();
    res.setHeader('X-Request-Id', reqId);
    const store = { reqId, userId: null };
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      if (skip(req)) return;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      context.run(store, () => log.info('request', {
        method: req.method,
        path: req.path, // no query string: it can carry email-link tokens
        status: res.statusCode,
        ms: Math.round(ms)
      }));
    });
    context.run(store, next);
  };
}

/** After sessions load: attach the user id to the current request's log context. */
function attachUser(req, res, next) {
  const store = context.getStore();
  if (store && req.session && req.session.userId) store.userId = req.session.userId;
  next();
}

module.exports = { log, requestContext, attachUser };
