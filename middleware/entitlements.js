const { loadState } = require('../utils/entitlements');
const { naira } = require('../utils/format');

const TTL_MS = 60 * 1000;

/**
 * Exposes `ent` ({ hasMentor, isTeacher }) and `naira()` to every view so the nav can
 * show the right links. Cached in the session for 60s (and refreshed immediately when a
 * flow sets req.session.entStale) so this costs ~1 query/minute/user, not 1 per request.
 */
function loadEntitlements() {
  return async function loadEntitlementsMiddleware(req, res, next) {
    res.locals.naira = naira;
    res.locals.ent = { hasMentor: false, isTeacher: false };
    if (!req.session || !req.session.userId) return next();
    try {
      const cached = req.session.ent;
      const fresh = cached && !req.session.entStale && Date.now() - cached.at < TTL_MS;
      if (!fresh) {
        const state = await loadState(req.session.userId);
        req.session.ent = {
          at: Date.now(),
          hasMentor: !!state.mentorMembership,
          isTeacher: state.isTeacher
        };
        req.session.entStale = false;
      }
      res.locals.ent = req.session.ent;
    } catch (err) {
      console.error('Entitlement load failed:', err.message); // never block the page on this
    }
    next();
  };
}

module.exports = { loadEntitlements };
