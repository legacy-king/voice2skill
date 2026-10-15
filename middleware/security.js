/**
 * Security middleware:
 *  - security headers via helmet, including a strict Content-Security-Policy (no inline scripts:
 *    page scripts live in public/js) and HSTS in production
 *  - session-based CSRF token (hidden field `_csrf` or X-CSRF-Token header)
 *  - rate limiting via express-rate-limit (per user when logged in, per IP otherwise), plus
 *    per-email limits on login and password-reset/verification emails
 *  - CORS for /api/* limited to CORS_ORIGINS
 *
 * Note: rate-limit counters are per-process memory, fine for a single Render instance; a second
 * instance needs a shared store (Postgres or Redis) first.
 */
const crypto = require('crypto');
const helmet = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const isProd = () => process.env.NODE_ENV === 'production';

/** Security headers applied to every response. */
function securityHeaders() {
  const prod = isProd();
  const headers = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Inline style attributes are still used in a few views; scripts are the XSS risk.
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        // Checkout posts to us and we redirect to Paystack; browsers apply form-action to redirects.
        formAction: ["'self'", 'https://checkout.paystack.com'],
        frameAncestors: ["'none'"],
        ...(prod ? { upgradeInsecureRequests: [] } : {})
      }
    },
    strictTransportSecurity: prod ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    xFrameOptions: { action: 'deny' }
  });
  return function securityHeadersMiddleware(req, res, next) {
    // Microphone for voice input on our own pages only; nothing else.
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=(), payment=(), usb=()');
    headers(req, res, next);
  };
}

/**
 * CORS for the JSON API. Today every caller is same-origin (no CORS needed); a future React
 * frontend on another origin must be listed in CORS_ORIGINS (comma-separated). Unlisted origins
 * get no CORS headers, so browsers refuse to let them read responses; CSRF still guards writes.
 */
function apiCors(req, res, next) {
  const origin = req.get('origin');
  const allowed = (process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
  const ok = !!origin && allowed.includes(origin);
  if (ok) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    if (!ok) return res.sendStatus(403);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    res.setHeader('Access-Control-Max-Age', '600');
    return res.sendStatus(204);
  }
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

  // Forms send a hidden `_csrf` field; fetch() calls send the same token in a header.
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token');
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

/** JSON callers (fetch/XHR, /api/*) get JSON; forms get the plain message. */
function wantsJson(req) {
  return req.path.startsWith('/api/') || req.is('application/json') || (req.get('accept') || '').includes('application/json');
}

/**
 * Rate limiter (express-rate-limit). Same signature as before, so routes didn't change.
 * Logged-in users are limited per account, not per IP: a whole bootcamp class often shares one
 * campus/wifi IP, and one student's burst must not lock out the rest.
 * @param {object} opts
 * @param {number} opts.windowMs window in ms
 * @param {number} opts.max max requests per window per user (or IP when logged out)
 * @param {string} opts.message response body on 429
 */
function rateLimiter({ windowMs = 15 * 60 * 1000, max = 100, message = 'Too many requests. Please try again later.' } = {}) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => (req.session && req.session.userId ? `u:${req.session.userId}` : `ip:${ipKeyGenerator(req.ip || '')}`),
    handler: (req, res) => (wantsJson(req)
      ? res.status(429).json({ error: 'rate_limited', message })
      : res.status(429).send(message))
  });
}

/**
 * Per-email login limit, on top of the per-IP one: 10 FAILED logins per email per 15 minutes
 * (LOGIN_MAX_PER_EMAIL), so one account can't be password-guessed from many IPs. Successful
 * logins don't count (the controller sets res.locals.loginOk). Runs after validation.
 */
const loginEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: () => Number(process.env.LOGIN_MAX_PER_EMAIL) || 10,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => `login:${(req.valid && req.valid.body.email) || 'none'}`,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.locals.loginOk === true,
  handler: (req, res) => res.redirect('/login?error=locked')
});

/**
 * Per-email limit on emails we send on request (password reset, verification resend): 5 per
 * hour per address, so the forms can't be used to flood someone's inbox. The response looks the
 * same as a normal send, so it doesn't reveal whether the address has an account.
 */
const resetEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: () => Number(process.env.EMAIL_MAX_PER_ADDRESS) || 5,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => `mail:${req.path}:${(req.valid && req.valid.body.email) || 'none'}`,
  handler: (req, res) => res.redirect(req.path.startsWith('/verify-email') ? '/verify-email?sent=1' : '/forgot-password?sent=1')
});

module.exports = { securityHeaders, csrfProtection, rateLimiter, loginEmailLimiter, resetEmailLimiter, apiCors, touchLastActive };
