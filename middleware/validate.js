/**
 * Request validation with zod (PLAN Phase 6). Every route that reads params, a body or a
 * logic-driving query value declares a schema; the controller then reads only `req.valid`
 * ({ params, query, body }), already trimmed/coerced, never `req.body` directly.
 *
 *   router.post('/x/:id', validate({ params: z.object({ id: id() }), body: … }, onInvalid.notFound), handler)
 *
 * qs can turn `a[]=1` or `a[b]=1` into arrays/objects; these schemas only accept strings, so such
 * payloads are rejected instead of reaching code that assumes a string. Unknown keys are dropped.
 * Display-only query flags (?error=, ?saved=1) are looked up in fixed maps and rendered escaped,
 * so they are not validated here.
 */
const { z } = require('zod');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Missing form fields arrive as undefined; treat them as '' so the length rules give the error.
const orEmpty = (schema) => z.preprocess((v) => (v === undefined || v === null ? '' : v), schema);

/** Trimmed string, at most `max` characters (longer is an error). */
const text = (max) => orEmpty(z.string().trim().max(max));
/** Trimmed string cut to `max` characters (for free text where truncating is friendlier). */
const clipped = (max) => orEmpty(z.string().transform((s) => s.trim().slice(0, max)));
/** Untrimmed secret (passwords): 1..200 chars when required. bcrypt only uses 72 bytes anyway. */
const secret = () => orEmpty(z.string().max(200));
const email = () => orEmpty(z.string().trim().toLowerCase().max(150));
/** Positive integer id in a URL segment. */
const id = () => z.string().regex(/^\d{1,9}$/).transform(Number);
/** Hex token from an email link (32 random bytes = 64 hex chars). */
const hexToken = () => orEmpty(z.string().trim().max(128).regex(/^[a-f0-9]*$/i));
const optional = (schema) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

function validate(schemas, onError = onInvalid.badRequest) {
  return function validateMiddleware(req, res, next) {
    const valid = {};
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part] || {});
      if (!result.success) {
        const issue = result.error.issues[0] || {};
        return onError(req, res, { part, field: issue.path && issue.path[0], code: issue.code, issue });
      }
      valid[part] = result.data;
    }
    // Several validate() steps can run on one route (e.g. params, then body): merge, don't replace.
    req.valid = { ...(req.valid || {}), ...valid };
    next();
  };
}

/** Ready-made responses for invalid input. */
const onInvalid = {
  badRequest: (req, res) => res.status(400).send('Invalid request.'),
  notFound: (req, res) => res.status(404).send('Page not found'),
  json: (req, res, { field }) => res.status(400).json({ error: 'invalid_input', field: field || null }),
  /** Redirect to a form page with ?error=<key>, the key chosen by the failing field. */
  redirect: (base, keys, fallback = 'invalid') => (req, res, { field }) => {
    const url = typeof base === 'function' ? base(req) : base;
    const key = (keys && keys[field]) || fallback;
    res.redirect(`${url}${url.includes('?') ? '&' : '?'}error=${encodeURIComponent(key)}`);
  }
};

module.exports = { validate, onInvalid, z, text, clipped, secret, email, id, hexToken, optional, EMAIL_RE };
