/**
 * Lightweight, dependency-free security middleware:
 *  - security headers (nosniff, frame options, referrer policy)
 *  - session-based CSRF token (double-submit via hidden field `_csrf`)
 *  - in-memory rate limiting (per IP) for auth-sensitive routes
 *
 * Note: the rate limiter is per-process memory — fine for a single-node app;
 * for multi-instance deployments swap in a shared store (Redis).
 */
const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Security headers applied to every response. */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0'); // modern browsers: rely on CSP/no-inline
  next();
}

/** Session-based CSRF protection. Must run after express-session. */
function csrfProtection(req, res, next) {
  // Lazily create the token once per session.
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  const sent = req.body && req.body._csrf;
  if (typeof sent !== 'string' || sent !== req.session.csrfToken) {
    return res.status(403).send('Invalid or missing CSRF token. Please refresh and try again.');
  }
  next();
}

/**
 * Throttled "last active" tracker. Updates req.session.lastActiveAt for
 * logged-in users, but at most once per `throttleMs` per session — otherwise
 * every request would write to the session store (express-session saves when
 * the session is modified). 5 minutes of slack is plenty for a security page.
 */
function touchLastActive({ throttleMs = 5 * 60 * 1000 } = {}) {
  return function touchLastActiveMiddleware(req, res, next) {
    if (req.session && req.session.userId) {
      const now = Date.now();
      // Missing/absent → 0 so the first request stamps it. A corrupt value
      // (NaN) also falls back to 0 so the throttle can't brick permanently.
      const last = req.session.lastActiveAt ? new Date(req.session.lastActiveAt).getTime() : 0;
      const lastTs = Number.isFinite(last) ? last : 0;
      if (now - lastTs >= throttleMs) {
        req.session.lastActiveAt = new Date(now).toISOString();
      }
    }
    next();
  };
}

/**
 * Minimal in-memory rate limiter.
 * @param {object} opts
 * @param {number} opts.windowMs sliding window in ms
 * @param {number} opts.max max requests per window per IP
 * @param {string} opts.message response body on 429
 */
function rateLimiter({ windowMs = 15 * 60 * 1000, max = 100, message = 'Too many requests. Please try again later.' } = {}) {
  const hits = new Map(); // ip -> { count, resetAt }

  // Prune expired entries when the map grows, so it never leaks unbounded memory.
  function pruneExpired(now) {
    for (const [ip, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(ip);
    }
  }

  return function rateLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();

    // Keep the map bounded: occasionally sweep stale keys.
    if (hits.size > 10_000) pruneExpired(now);

    const entry = hits.get(ip);

    if (!entry || entry.resetAt <= now) {
      hits.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).send(message);
    }
    next();
  };
}

module.exports = { securityHeaders, csrfProtection, rateLimiter, touchLastActive };
