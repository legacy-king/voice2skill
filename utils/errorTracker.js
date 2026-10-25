/**
 * Basic error tracking without a vendor SDK (an SDK adds memory and startup CPU on a small
 * instance, which is the opposite of what this audit is for).
 *
 * capture(err, context) is called from the central Express error handler, the process-level
 * crash handlers and failed background jobs. It
 *   - groups errors by a fingerprint (error name + first stack frame, line numbers stripped),
 *   - keeps counts you can read with stats(),
 *   - and, if ERROR_WEBHOOK_URL is set (Slack, Discord, ntfy, or any URL that accepts a JSON POST),
 *     sends ONE alert per fingerprint per cooldown (ERROR_ALERT_COOLDOWN_MS, default 10 min), at
 *     most ERROR_ALERT_MAX_PER_HOUR (default 20) in total, so an error loop cannot flood the
 *     channel or burn CPU on alerts.
 *
 * Alerts carry only: error name, message (email addresses redacted), top stack frames, request
 * method + path (no query string, no body, no cookies, no user data), and counts.
 * The full detail is always in the JSON error log line written by utils/log.js.
 */
const { log } = require('./log');

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const counts = new Map();      // fingerprint -> { count, first, last, name, message }
const lastAlertAt = new Map(); // fingerprint -> ms
let alertTimes = [];           // ms of alerts in the last hour

const cooldownMs = () => Number(process.env.ERROR_ALERT_COOLDOWN_MS) || 10 * 60 * 1000;
const maxPerHour = () => Number(process.env.ERROR_ALERT_MAX_PER_HOUR) || 20;
const webhookUrl = () => (process.env.ERROR_WEBHOOK_URL || '').trim();

function toError(value) {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : JSON.stringify(value));
}

function fingerprint(err) {
  const frame = String(err.stack || '').split('\n').slice(1).find((l) => l.includes('at ')) || '';
  return `${err.name}:${frame.replace(/:\d+:\d+/g, '').replace(/\(.*[\\/]node_modules[\\/]/, '(node_modules/').trim().slice(0, 160)}`;
}

function redact(text) {
  return String(text).replace(EMAIL_RE, '[email]').slice(0, 500);
}

/** Records an error and, when configured and not rate-limited, sends an alert. Never throws. */
function capture(value, context = {}) {
  try {
    const err = toError(value);
    const fp = fingerprint(err);
    const now = Date.now();
    const entry = counts.get(fp) || { count: 0, first: now, name: err.name, message: redact(err.message) };
    entry.count += 1;
    entry.last = now;
    counts.set(fp, entry);
    if (counts.size > 500) counts.delete(counts.keys().next().value); // bounded memory

    const url = webhookUrl();
    if (!url) return;
    if (now - (lastAlertAt.get(fp) || 0) < cooldownMs()) return;
    alertTimes = alertTimes.filter((t) => now - t < 60 * 60 * 1000);
    if (alertTimes.length >= maxPerHour()) return;
    lastAlertAt.set(fp, now);
    alertTimes.push(now);
    if (lastAlertAt.size > 500) lastAlertAt.delete(lastAlertAt.keys().next().value);

    const where = context.method && context.path ? ` on ${context.method} ${context.path}` : (context.source ? ` in ${context.source}` : '');
    const frames = String(err.stack || '').split('\n').slice(1, 6).map((l) => l.trim()).join('\n');
    const text = `Voice2Skill error${where}: ${err.name}: ${redact(err.message)}\n(seen ${entry.count}x since boot)\n${frames}`;
    // `text` for Slack/ntfy-style hooks, `content` for Discord.
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, content: text.slice(0, 1900) }),
      signal: AbortSignal.timeout(5000)
    }).catch((e) => log.warn('Error alert could not be sent', { error: e.message }));
  } catch (e) {
    // Error tracking must never be the thing that fails.
    log.warn('errorTracker failed', { error: e && e.message });
  }
}

/** Counts since boot, most frequent first (for a log line or a future admin page). */
function stats() {
  return [...counts.entries()]
    .map(([fp, e]) => ({ fingerprint: fp, name: e.name, message: e.message, count: e.count, last: new Date(e.last).toISOString() }))
    .sort((a, b) => b.count - a.count);
}

function reset() { counts.clear(); lastAlertAt.clear(); alertTimes = []; }

module.exports = { capture, stats, reset, fingerprint };
