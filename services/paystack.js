/**
 * Thin Paystack client (https://paystack.com/docs/api). No SDK — just fetch.
 *
 * PAYSTACK_MOCK=1 swaps the network calls for an in-memory fake (tests/local dev).
 * Amounts are integer kobo everywhere.
 */
const crypto = require('crypto');

const BASE = 'https://api.paystack.co';
const MOCK = process.env.PAYSTACK_MOCK === '1';
const mockStore = new Map(); // reference -> amountKobo (mock mode only)

function secret() {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new Error('PAYSTACK_SECRET_KEY is not set');
  return key;
}

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${secret()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status === false) {
    throw new Error(`Paystack ${method} ${path} failed: ${json.message || res.status}`);
  }
  return json.data;
}

/** Start a checkout. Returns { authorization_url, reference }. */
async function initialize({ email, amountKobo, reference, callbackUrl, metadata }) {
  if (MOCK) {
    mockStore.set(reference, amountKobo);
    return { authorization_url: `${callbackUrl}?reference=${encodeURIComponent(reference)}`, reference };
  }
  return call('POST', '/transaction/initialize', {
    email,
    amount: amountKobo,
    currency: 'NGN',
    reference,
    callback_url: callbackUrl,
    metadata
  });
}

/** Ask Paystack what happened to a reference. Returns the transaction `data` object. */
async function verify(reference) {
  if (MOCK) {
    if (!mockStore.has(reference)) return { status: 'abandoned', reference };
    return { status: 'success', reference, amount: mockStore.get(reference), currency: 'NGN', fees: 0 };
  }
  return call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
}

/** Webhook authenticity: HMAC-SHA512 of the RAW body with the secret key. */
function verifySignature(rawBody, signature) {
  if (!signature || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac('sha512', secret()).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { initialize, verify, verifySignature };
