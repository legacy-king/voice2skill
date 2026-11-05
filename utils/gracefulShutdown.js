/**
 * Graceful shutdown, kept out of server.js so it can be tested with fakes.
 *
 * Render sends SIGTERM on every deploy and restart. The handler stops accepting connections, lets
 * in-flight requests finish, stops the background timers, closes the database pool and exits 0.
 * If that has not finished within `timeoutMs` it exits 1 anyway: a stuck request must never keep
 * an old instance alive (or make Render SIGKILL it mid-write).
 * Calling it twice (e.g. SIGINT then SIGTERM) is harmless.
 */
function createShutdown({ server, pool, stops = [], log, exit = (code) => process.exit(code), timeoutMs = 15000 }) {
  let shuttingDown = false;
  return function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    const hard = setTimeout(() => {
      log.warn('Graceful shutdown timed out, forcing exit');
      exit(1);
    }, timeoutMs);
    if (typeof hard.unref === 'function') hard.unref();
    for (const stop of stops) {
      try { stop(); } catch (err) { log.warn('Shutdown step failed', { error: err.message }); }
    }
    server.close(() => {
      Promise.resolve(pool.end()).catch(() => {}).finally(() => {
        clearTimeout(hard);
        exit(0);
      });
    });
    // Keep-alive sockets would otherwise hold close() open until they time out.
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  };
}

module.exports = { createShutdown };
