#!/usr/bin/env node
/**
 * End-to-end test of the cohort / payment / mentor / teacher flows.
 * Boots the real server against a real Postgres and drives it over HTTP.
 *
 * Needs: DATABASE_URL pointing at a DISPOSABLE database with `npm run migrate` already applied.
 * Uses mock Paystack and mock LLM providers (scripts/mockLlmServer.js, reached through the real
 * router in services/llm.js), so it costs nothing and needs no keys.
 *
 * Usage: DATABASE_URL=... DATABASE_SSL=false npm run test:cohorts
 */
process.env.PAYSTACK_MOCK = '1';
process.env.EMAIL_MODE = 'log';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_cohort_suite';
process.env.SESSION_SECRET = 'test-secret';
process.env.MENTOR_DAILY_LIMIT = '3';
process.env.PREMIUM_DAILY_LIMIT = '2';
process.env.STT_MAX_BYTES = '50000';
process.env.STT_DAILY_LIMIT_FREE = '4';
process.env.STT_DAILY_LIMIT_PAID = '6';
process.env.NODE_ENV = 'test';
process.env.COURSE_MOCK = '1';
// Never call a real LLM from tests, even if .env has keys (dotenv won't override set vars). The
// router is pointed at mock providers in main().
for (const k of ['GROQ_KEY', 'GEMINI_KEY', 'GEMINI_API_KEY', 'MISTRAL_KEY', 'OPENROUTER_KEY', 'MENTOR_MOCK', 'MENTOR_MODEL']) process.env[k] = '';
for (const k of Object.keys(process.env)) if (/^LLM_/.test(k)) delete process.env[k];
const NO_LLM_ENV = { ...process.env }; // for child scripts that must not reach any provider

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const pool = require('../config/db');
const { startMockLlm } = require('./mockLlmServer');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const run = Date.now().toString(36);
let passed = 0, failed = 0;

function check(label, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} ${extra}`); }
}

/** Tiny cookie-jar client that follows nothing (we assert on redirects). */
function client() {
  let cookie = '';
  async function req(method, url, { form, json, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    let body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (json) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (raw !== undefined) body = raw;
    const res = await fetch(BASE + url, { method, headers: h, body, redirect: 'manual' });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) cookie = c.split(';')[0]; // single session cookie is enough here
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text, res };
  }
  async function csrf(pagePath = '/login') {
    const r = await req('GET', pagePath);
    const m = r.text.match(/name="_csrf" value="([a-f0-9]+)"/) || r.text.match(/const csrf = "([a-f0-9]+)"/) || r.text.match(/var csrf = "([a-f0-9]+)"/) || r.text.match(/data-csrf="([a-f0-9]+)"/);
    return m && m[1];
  }
  return { req, csrf, get cookie() { return cookie; } };
}

async function makeUser(name) {
  const email = `${name}.${run}@example.com`;
  const c = client();
  let t = await c.csrf('/signup');
  await c.req('POST', '/signup', { form: { _csrf: t, name, email, password: 'password123' } });
  await pool.query('UPDATE users SET email_verified = TRUE WHERE email = $1', [email]);
  t = await c.csrf('/login');
  const r = await c.req('POST', '/login', { form: { _csrf: t, email, password: 'password123' } });
  if (r.location !== '/dashboard') throw new Error(`login failed for ${email}: ${r.status} ${r.location}`);
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  return { c, email, id: rows[0].id };
}

function sign(bodyStr) {
  return crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(bodyStr).digest('hex');
}

async function webhook(c, payload, signature) {
  const body = JSON.stringify(payload);
  return c.req('POST', '/webhooks/paystack', {
    raw: body, headers: { 'content-type': 'application/json', 'x-paystack-signature': signature ?? sign(body) }
  });
}

async function main() {
  const mock = await startMockLlm();
  process.env.GROQ_KEY = 'test-groq';
  process.env.GEMINI_KEY = 'test-gemini';
  process.env.LLM_BASEURL_GROQ = mock.url('groq');
  process.env.LLM_BASEURL_GEMINI = mock.url('gemini');
  process.env.LLM_TIMEOUT_MS = '2000';
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/login'); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }

  try {
    console.log('Setup');
    const tutor = await makeUser('tutor');
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const outsider = await makeUser('outsider');

    const org = spawnSync('node', [path.join(__dirname, 'createOrg.js'), 'Test Academy', tutor.email, '20', 'net'], { env: process.env, encoding: 'utf8' });
    check('createOrg script succeeds', org.status === 0, org.stderr);

    console.log('Teacher: create cohort');
    check('student cannot open /teacher', (await alice.c.req('GET', '/teacher')).status === 404);
    let t = await tutor.c.csrf('/teacher');
    check('teacher can open /teacher', !!t);
    const bad = await tutor.c.req('POST', '/teacher/cohorts', { form: { _csrf: t, name: 'x', price: '5000', accessDays: '30', curriculum: '' } });
    check('invalid cohort name rejected', bad.location === '/teacher?error=name');
    const made = await tutor.c.req('POST', '/teacher/cohorts', { form: { _csrf: t, name: 'Frontend Nov', price: '5000', accessDays: '30', curriculum: 'Week 1: HTML semantics. Week 2: CSS flexbox.' } });
    const cohortId = Number((made.location || '').match(/\/teacher\/cohorts\/(\d+)/)?.[1]);
    check('cohort created and redirected', Number.isInteger(cohortId), made.location);
    const page = await tutor.c.req('GET', `/teacher/cohorts/${cohortId}`);
    const code = page.text.match(/co-code co-code-lg">([A-Z0-9]+)</)?.[1];
    check('invite code shown (8 chars)', !!code && code.length === 8, code);
    check('student cannot open cohort admin page', (await alice.c.req('GET', `/teacher/cohorts/${cohortId}`)).status === 404);
    check('student cannot update cohort', (await alice.c.req('POST', `/teacher/cohorts/${cohortId}`, { form: { _csrf: await alice.c.csrf('/join'), name: 'hacked', price: '0', accessDays: '30', curriculum: '' } })).status === 404);

    console.log('Student: join + paywall');
    const m0 = await alice.c.req('GET', '/mentor');
    check('mentor blocked before joining', m0.location === '/join?message=need_access');
    t = await alice.c.csrf('/join');
    const wrong = await alice.c.req('POST', '/join', { form: { _csrf: t, code: 'ZZZZ-ZZZZ' } });
    check('wrong code rejected', wrong.location === '/join?error=invalid_code');
    const joined = await alice.c.req('POST', '/join', { form: { _csrf: t, code: code.toLowerCase().replace(/^(.{4})/, '$1-') } });
    check('lowercase/dashed code accepted', joined.location === '/join', joined.location);
    const again = await alice.c.req('POST', '/join', { form: { _csrf: t, code } });
    check('joining twice is a no-op', again.location === '/join?message=already');
    check('mentor still blocked until paid', (await alice.c.req('GET', '/mentor')).location === '/join?message=need_access');
    const noAccess = await alice.c.req('POST', '/mentor/message', { json: { message: 'hi', clientMsgId: 'a'.repeat(16) }, headers: { 'x-csrf-token': t } });
    check('mentor API returns 402 before payment', noAccess.status === 402);
    check('JSON without CSRF header is rejected', (await alice.c.req('POST', '/mentor/message', { json: { message: 'hi', clientMsgId: 'a'.repeat(16) } })).status === 403);
    check('outsider (never joined) is blocked', (await outsider.c.req('POST', '/mentor/message', { json: { message: 'hi', clientMsgId: 'b'.repeat(16) }, headers: { 'x-csrf-token': await outsider.c.csrf('/join') } })).status === 402);

    console.log('Payment: browser callback path');
    const pay = await alice.c.req('POST', `/pay/${cohortId}`, { form: { _csrf: t } });
    check('pay redirects to checkout', /\/pay\/callback\?reference=/.test(pay.location || ''), pay.location);
    const ref1 = decodeURIComponent((pay.location || '').split('reference=')[1] || '');
    const cb = await alice.c.req('GET', new URL(pay.location).pathname + new URL(pay.location).search);
    check('callback settles and goes to mentor', cb.location === '/mentor?paid=1', cb.location);
    let p = (await pool.query('SELECT * FROM payments WHERE reference = $1', [ref1])).rows[0];
    check('payment marked success, 500000 kobo', p.status === 'success' && p.amount_kobo === 500000);
    check('org share = 20% of net (100000 kobo)', p.org_share_kobo === 100000, String(p.org_share_kobo));
    const mem1 = (await pool.query('SELECT * FROM memberships WHERE user_id=$1 AND cohort_id=$2', [alice.id, cohortId])).rows[0];
    const days1 = Math.round((new Date(mem1.access_until) - Date.now()) / 86400000);
    check('access active for ~30 days', mem1.status === 'active' && days1 >= 29 && days1 <= 30, String(days1));
    const cb2 = await alice.c.req('GET', new URL(pay.location).pathname + new URL(pay.location).search);
    const mem1b = (await pool.query('SELECT access_until FROM memberships WHERE user_id=$1 AND cohort_id=$2', [alice.id, cohortId])).rows[0];
    check('replaying the callback does NOT extend access again', +new Date(mem1b.access_until) === +new Date(mem1.access_until) && cb2.location === '/mentor?paid=1');
    check('other student cannot settle alice\'s reference', (await bob.c.req('GET', `/pay/callback?reference=${ref1}`)).location === '/join');

    console.log('Payment: signed webhook path (Bob)');
    const bt = await bob.c.csrf('/join');
    await bob.c.req('POST', '/join', { form: { _csrf: bt, code } });
    const bpay = await bob.c.req('POST', `/pay/${cohortId}`, { form: { _csrf: bt } });
    const ref2 = decodeURIComponent((bpay.location || '').split('reference=')[1] || '');
    const evt = { event: 'charge.success', data: { reference: ref2, status: 'success', amount: 500000, currency: 'NGN', fees: 7500 } };
    check('webhook with bad signature => 401', (await webhook(bob.c, evt, 'deadbeef')).status === 401);
    check('webhook with no signature => 401', (await bob.c.req('POST', '/webhooks/paystack', { raw: JSON.stringify(evt), headers: { 'content-type': 'application/json' } })).status === 401);
    check('no access granted by unsigned attempts', (await pool.query("SELECT status FROM memberships WHERE user_id=$1 AND cohort_id=$2", [bob.id, cohortId])).rows[0].status === 'pending_payment');
    check('valid webhook => 200', (await webhook(bob.c, evt)).status === 200);
    p = (await pool.query('SELECT * FROM payments WHERE reference = $1', [ref2])).rows[0];
    check('fee recorded 7500, share = 20% of (500000-7500) = 98500', p.provider_fee_kobo === 7500 && p.org_share_kobo === 98500, `${p.provider_fee_kobo}/${p.org_share_kobo}`);
    const bmem = (await pool.query('SELECT access_until FROM memberships WHERE user_id=$1 AND cohort_id=$2', [bob.id, cohortId])).rows[0];
    await webhook(bob.c, evt);
    await webhook(bob.c, evt);
    const bmem2 = (await pool.query('SELECT access_until FROM memberships WHERE user_id=$1 AND cohort_id=$2', [bob.id, cohortId])).rows[0];
    check('replayed webhooks are idempotent (access unchanged)', +new Date(bmem.access_until) === +new Date(bmem2.access_until));
    check('exactly one successful payment row for that user', (await pool.query("SELECT COUNT(*)::int n FROM payments WHERE user_id=$1 AND status='success'", [bob.id])).rows[0].n === 1);

    // concurrency: 5 simultaneous deliveries of a fresh payment must extend exactly once
    const bpay2 = await bob.c.req('POST', `/pay/${cohortId}`, { form: { _csrf: bt } });
    const ref3 = decodeURIComponent((bpay2.location || '').split('reference=')[1] || '');
    const before = +new Date((await pool.query('SELECT access_until FROM memberships WHERE user_id=$1 AND cohort_id=$2', [bob.id, cohortId])).rows[0].access_until);
    const evt3 = { event: 'charge.success', data: { reference: ref3, status: 'success', amount: 500000, currency: 'NGN', fees: 0 } };
    await Promise.all([1, 2, 3, 4, 5].map(() => webhook(bob.c, evt3)));
    const after = +new Date((await pool.query('SELECT access_until FROM memberships WHERE user_id=$1 AND cohort_id=$2', [bob.id, cohortId])).rows[0].access_until);
    check('5 concurrent webhooks extend by exactly 30 days once (renewal stacks)', Math.round((after - before) / 86400000) === 30, String((after - before) / 86400000));

    // tampered amount
    const bpay3 = await bob.c.req('POST', `/pay/${cohortId}`, { form: { _csrf: bt } });
    const ref4 = decodeURIComponent((bpay3.location || '').split('reference=')[1] || '');
    const w4 = await webhook(bob.c, { event: 'charge.success', data: { reference: ref4, status: 'success', amount: 100, currency: 'NGN', fees: 0 } });
    check('underpaid webhook is acknowledged but NOT settled', w4.status === 200 && (await pool.query('SELECT status FROM payments WHERE reference=$1', [ref4])).rows[0].status === 'pending');
    check('webhook for unknown reference is harmless (200)', (await webhook(bob.c, { event: 'charge.success', data: { reference: 'nope', status: 'success', amount: 1, currency: 'NGN' } })).status === 200);

    console.log('Mentor chat');
    const mt = await alice.c.csrf('/mentor');
    check('mentor page renders for paid student', !!mt);
    const id1 = crypto.randomBytes(8).toString('hex');
    const r1 = await alice.c.req('POST', '/mentor/message', { json: { message: 'What is flexbox?', clientMsgId: id1 }, headers: { 'x-csrf-token': mt } });
    const j1 = JSON.parse(r1.text);
    check('mentor replies', r1.status === 200 && /mock mentor/.test(j1.reply), r1.text);
    const r1b = await alice.c.req('POST', '/mentor/message', { json: { message: 'What is flexbox?', clientMsgId: id1 }, headers: { 'x-csrf-token': mt } });
    check('same clientMsgId replays the stored reply', JSON.parse(r1b.text).replayed === true && JSON.parse(r1b.text).reply === j1.reply);
    const used = (await pool.query("SELECT SUM(count)::int n FROM ai_usage WHERE user_id=$1", [alice.id])).rows[0].n;
    check('replay was not billed twice (usage = 1)', used === 1, String(used));
    check('empty message => 400', (await alice.c.req('POST', '/mentor/message', { json: { message: '   ', clientMsgId: id1 + 'x' }, headers: { 'x-csrf-token': mt } })).status === 400);
    check('over-long message => 400', (await alice.c.req('POST', '/mentor/message', { json: { message: 'a'.repeat(1001), clientMsgId: id1 + 'y' }, headers: { 'x-csrf-token': mt } })).status === 400);
    for (let i = 0; i < 2; i++) await alice.c.req('POST', '/mentor/message', { json: { message: `q${i}`, clientMsgId: crypto.randomBytes(8).toString('hex') }, headers: { 'x-csrf-token': mt } });
    const capped = await alice.c.req('POST', '/mentor/message', { json: { message: 'one too many', clientMsgId: crypto.randomBytes(8).toString('hex') }, headers: { 'x-csrf-token': mt } });
    check('4th message of the day => 429 daily_limit (cap=3)', capped.status === 429 && JSON.parse(capped.text).error === 'daily_limit', capped.text);
    const usedAfter = (await pool.query("SELECT SUM(count)::int n FROM ai_usage WHERE user_id=$1", [alice.id])).rows[0].n;
    check('refused request does not consume budget (usage stays 3)', usedAfter === 3, String(usedAfter));
    const hist = await alice.c.req('GET', '/mentor');
    check('history persisted on the page', /What is flexbox\?/.test(hist.text));
    check('XSS in messages is escaped on render', await (async () => {
      await pool.query("INSERT INTO mentor_messages (user_id, cohort_id, role, content) VALUES ($1,$2,'user',$3)", [alice.id, cohortId, '<script>alert(1)</script>']);
      const h = await alice.c.req('GET', '/mentor');
      return !h.text.includes('<script>alert(1)</script>') && h.text.includes('&lt;script&gt;');
    })());

    console.log('Expiry');
    await pool.query("UPDATE memberships SET access_until = NOW() - INTERVAL '1 day' WHERE user_id=$1 AND cohort_id=$2", [bob.id, cohortId]);
    const bt2 = await bob.c.csrf('/join');
    const exp = await bob.c.req('POST', '/mentor/message', { json: { message: 'hi', clientMsgId: crypto.randomBytes(8).toString('hex') }, headers: { 'x-csrf-token': bt2 } });
    check('expired membership loses mentor access (402)', exp.status === 402);
    const jp = await bob.c.req('GET', '/join');
    check('join page offers renewal', /Access expired/.test(jp.text));

    console.log('Teacher roster + ledger');
    const rm = await pool.query("INSERT INTO roadmaps (user_id, track_id, content) VALUES ($1, 1, '{\"weeks\":[]}') RETURNING id", [alice.id]);
    await pool.query("INSERT INTO checkins (user_id, roadmap_id, checkin_date, notes) VALUES ($1, $2, CURRENT_DATE, 'secret note')", [alice.id, rm.rows[0].id]);
    const roster = await tutor.c.req('GET', `/teacher/cohorts/${cohortId}`);
    check('roster lists both students', roster.text.includes('alice') && roster.text.includes('bob'));
    check('roster shows alice\'s check-in count but never the note text', /today/.test(roster.text) && !roster.text.includes('secret note'));
    check('expired student flagged Expired', /Expired/.test(roster.text));
    const led = spawnSync('node', [path.join(__dirname, 'ledger.js')], { env: process.env, encoding: 'utf8' });
    check('ledger: collected 3 payments = ₦15,000', /collected ₦15,000/.test(led.stdout), led.stdout);
    check('ledger: bootcamp share = 100000+98500+100000 kobo = ₦2,985', /bootcamp share ₦2,985/.test(led.stdout), led.stdout);
    const po = spawnSync('node', [path.join(__dirname, 'ledger.js'), 'payout', String((await pool.query('SELECT id FROM organizations WHERE owner_user_id = $1', [tutor.id])).rows[0].id), '1000', 'Oct payout'], { env: process.env, encoding: 'utf8' });
    check('ledger payout reduces what is owed (₦1,985)', /OWED TO BOOTCAMP: ₦1,985/.test(po.stdout), po.stdout);
    const tp = await tutor.c.req('GET', `/teacher/cohorts/${cohortId}`);
    check('teacher sees the same owed figure', /₦1,985/.test(tp.text));

    console.log('Settings');
    t = await tutor.c.csrf(`/teacher/cohorts/${cohortId}`);
    const upd = await tutor.c.req('POST', `/teacher/cohorts/${cohortId}`, { form: { _csrf: t, name: 'Frontend Nov', price: '7500', accessDays: '30', curriculum: 'New syllabus', active: 'on' } });
    check('cohort update saved', upd.location === `/teacher/cohorts/${cohortId}?saved=1`);
    check('price stored in kobo', (await pool.query('SELECT price_kobo FROM cohorts WHERE id=$1', [cohortId])).rows[0].price_kobo === 750000);
    await tutor.c.req('POST', `/teacher/cohorts/${cohortId}`, { form: { _csrf: t, name: 'Frontend Nov', price: '7500', accessDays: '30', curriculum: 'x' } }); // active unchecked => closed
    const closed = await outsider.c.req('POST', '/join', { form: { _csrf: await outsider.c.csrf('/join'), code } });
    check('closed cohort rejects new joins', closed.location === '/join?error=invalid_code');

    console.log('Regressions found in independent review');
    check('fractional price rejected', (await tutor.c.req('POST', `/teacher/cohorts/${cohortId}`, { form: { _csrf: t, name: 'Frontend Nov', price: '1500.5', accessDays: '30', curriculum: '' } })).location === `/teacher/cohorts/${cohortId}?error=price`);
    check('"5,000" and "₦5000" still parse', (await tutor.c.req('POST', `/teacher/cohorts/${cohortId}`, { form: { _csrf: t, name: 'Frontend Nov', price: '₦5,000', accessDays: '30', curriculum: 'x', active: 'on' } })).location === `/teacher/cohorts/${cohortId}?saved=1`);

    // 1. closing a cohort must not cut off a student who already paid
    const carol = await makeUser('carol');
    const ct = await carol.c.csrf('/join');
    await carol.c.req('POST', '/join', { form: { _csrf: ct, code } });
    const cpay = await carol.c.req('POST', `/pay/${cohortId}`, { form: { _csrf: ct } });
    await carol.c.req('GET', new URL(cpay.location).pathname + new URL(cpay.location).search);
    await pool.query('UPDATE cohorts SET active = FALSE WHERE id = $1', [cohortId]);
    const stillOk = await carol.c.req('POST', '/mentor/message', { json: { message: 'hello', clientMsgId: crypto.randomBytes(8).toString('hex') }, headers: { 'x-csrf-token': ct } });
    check('closed cohort: already-paid student keeps mentor access', stillOk.status === 200, stillOk.text);
    const renew = await carol.c.req('POST', `/pay/${cohortId}`, { form: { _csrf: ct } });
    check('closed cohort: paid student can still renew', /\/pay\/callback\?reference=/.test(renew.location || ''), renew.location);
    // ...but a student who joined and never paid cannot make a first payment into a closed cohort
    await pool.query("INSERT INTO memberships (user_id, cohort_id, role, status) VALUES ($1, $2, 'student', 'pending_payment')", [outsider.id, cohortId]);
    const ot = await outsider.c.csrf('/join');
    check('closed cohort: unpaid student cannot start a first payment', (await outsider.c.req('POST', `/pay/${cohortId}`, { form: { _csrf: ot } })).location === '/join?message=closed');
    check('closed cohort: join page shows it as closed', /Cohort closed/.test((await outsider.c.req('GET', '/join')).text));
    await pool.query('UPDATE cohorts SET active = TRUE WHERE id = $1', [cohortId]);

    // 2. free cohorts: activation, renewal after expiry, and paid->free switch
    t = await tutor.c.csrf('/teacher');
    const freeMade = await tutor.c.req('POST', '/teacher/cohorts', { form: { _csrf: t, name: 'Free taster', price: '0', accessDays: '14', curriculum: 'Intro' } });
    const freeId = Number(freeMade.location.match(/cohorts\/(\d+)/)[1]);
    const freeCode = (await pool.query('SELECT invite_code FROM cohorts WHERE id=$1', [freeId])).rows[0].invite_code;
    const dave = await makeUser('dave');
    const dt = await dave.c.csrf('/join');
    check('free cohort: joining gives immediate mentor access', (await dave.c.req('POST', '/join', { form: { _csrf: dt, code: freeCode } })).location === '/mentor');
    await pool.query("UPDATE memberships SET access_until = NOW() - INTERVAL '1 day' WHERE user_id=$1 AND cohort_id=$2", [dave.id, freeId]);
    check('free cohort: expired access shows a Renew button', /Renew free access/.test((await dave.c.req('GET', '/join')).text));
    check('free cohort: re-entering the code renews it', (await dave.c.req('POST', '/join', { form: { _csrf: dt, code: freeCode } })).location === '/mentor');
    check('free cohort: renewed ~14 days', Math.round((new Date((await pool.query('SELECT access_until FROM memberships WHERE user_id=$1 AND cohort_id=$2', [dave.id, freeId])).rows[0].access_until) - Date.now()) / 86400000) >= 13);
    check('free cohort: active member re-entering code is a no-op', (await dave.c.req('POST', '/join', { form: { _csrf: dt, code: freeCode } })).location === '/join?message=already');

    const erin = await makeUser('erin');
    const et = await erin.c.csrf('/join');
    await erin.c.req('POST', '/join', { form: { _csrf: et, code } });            // pending in the PAID cohort
    await pool.query('UPDATE cohorts SET price_kobo = 0 WHERE id = $1', [cohortId]); // tutor switches it to free
    check('paid->free switch: stale Pay button explains instead of 404', (await erin.c.req('POST', `/pay/${cohortId}`, { form: { _csrf: et } })).location === '/join?message=now_free');
    check('paid->free switch: pending student can activate', (await erin.c.req('POST', '/join', { form: { _csrf: et, code } })).location === '/mentor');
    await pool.query('UPDATE cohorts SET price_kobo = 500000 WHERE id = $1', [cohortId]);

    // amount mismatch on the browser callback gets its own message (not "not paid yet")
    const bt3 = await bob.c.csrf('/join');
    const mpay = await bob.c.req('POST', `/pay/${cohortId}`, { form: { _csrf: bt3 } });
    const mref = decodeURIComponent((mpay.location || '').split('reference=')[1] || '');
    await pool.query('UPDATE payments SET amount_kobo = amount_kobo + 100 WHERE reference = $1', [mref]);
    const mcb = await bob.c.req('GET', new URL(mpay.location).pathname + new URL(mpay.location).search);
    check('amount mismatch on callback => amount_mismatch message, not settled', mcb.location === '/join?message=amount_mismatch'
      && (await pool.query('SELECT status FROM payments WHERE reference=$1', [mref])).rows[0].status === 'pending', mcb.location);

    // 3. orphaned in-flight message does not block retries forever
    const orphanId = crypto.randomBytes(8).toString('hex');
    await pool.query("INSERT INTO mentor_messages (user_id, cohort_id, role, content, client_msg_id, created_at) VALUES ($1,$2,'user','orphan',$3, NOW() - INTERVAL '5 minutes')", [carol.id, cohortId, orphanId]);
    const orphan = await carol.c.req('POST', '/mentor/message', { json: { message: 'orphan', clientMsgId: orphanId }, headers: { 'x-csrf-token': ct } });
    check('stale in-progress message is recovered on retry', orphan.status === 200 && !!JSON.parse(orphan.text).reply, orphan.text);
    const freshId = crypto.randomBytes(8).toString('hex');
    await pool.query("INSERT INTO mentor_messages (user_id, cohort_id, role, content, client_msg_id) VALUES ($1,$2,'user','fresh',$3)", [carol.id, cohortId, freshId]);
    check('a genuinely in-flight message still answers 202', (await carol.c.req('POST', '/mentor/message', { json: { message: 'fresh', clientMsgId: freshId }, headers: { 'x-csrf-token': ct } })).status === 202);

    console.log('Tiers: Free has no AI');
    const fred = await makeUser('fred');
    const frm = await pool.query(
      "INSERT INTO roadmaps (user_id, track_id, content) VALUES ($1, 1, $2) RETURNING id",
      [fred.id, JSON.stringify({ weeks: [{ focus: 'Basics', days: [{ task: 'Day 1 task' }, { task: 'Day 2 task' }] }] })]
    );
    const fct = await fred.c.csrf('/join');
    await fred.c.req('POST', `/roadmaps/${frm.rows[0].id}/checkin`, { form: { _csrf: fct, notes: 'did day 1' } });
    const fcoach = (await pool.query(
      'SELECT cr.is_fallback FROM coach_responses cr JOIN checkins c ON c.id = cr.checkin_id WHERE c.user_id = $1', [fred.id]
    )).rows[0];
    check('free check-in gets the template coach reply (no AI)', fcoach && fcoach.is_fallback === true);
    check('free user cannot open the mentor', (await fred.c.req('GET', '/mentor')).location === '/join?message=need_access');

    console.log('Premium (individual)');
    const premiumRow = (await pool.query("SELECT * FROM cohorts WHERE kind = 'premium'")).rows[0];
    check('premium plan seeded by migration (₦6,000 / 30 days)', premiumRow && premiumRow.price_kobo === 600000 && premiumRow.access_days === 30);
    const pam = await makeUser('pam');
    const pt = await pam.c.csrf('/join');
    check('join page offers Premium with the DB price', /Upgrade for ₦6,000/.test((await pam.c.req('GET', '/join')).text));
    check('POST /premium without CSRF is rejected', (await pam.c.req('POST', '/premium', { form: {} })).status === 403);
    const ppay = await pam.c.req('POST', '/premium', { form: { _csrf: pt } });
    check('POST /premium starts a Paystack checkout', /\/pay\/callback\?reference=/.test(ppay.location || ''), ppay.location);
    const pref = decodeURIComponent((ppay.location || '').split('reference=')[1] || '');
    const pcb = await pam.c.req('GET', new URL(ppay.location).pathname + new URL(ppay.location).search);
    check('premium payment settles and opens the mentor', pcb.location === '/mentor?paid=1', pcb.location);
    const prow = (await pool.query('SELECT * FROM payments WHERE reference = $1', [pref])).rows[0];
    check('premium charged ₦6,000 from the DB, 0% revenue share', prow.status === 'success' && prow.amount_kobo === 600000 && prow.org_share_kobo === 0);
    const pmentor = await pam.c.req('GET', '/mentor');
    check('premium mentor is the Voice2Skill mentor', /Voice2Skill Premium/.test(pmentor.text) && /Voice2Skill AI mentor/.test(pmentor.text));
    check('premium daily cap comes from PREMIUM_DAILY_LIMIT', /of 2 messages left today/.test(pmentor.text));
    check('join page stops offering Premium once bought', !/Upgrade for/.test((await pam.c.req('GET', '/join')).text));
    check('tutor cannot open or edit the Premium plan', (await tutor.c.req('GET', `/teacher/cohorts/${premiumRow.id}`)).status === 404
      && (await tutor.c.req('POST', `/teacher/cohorts/${premiumRow.id}`, { form: { _csrf: await tutor.c.csrf('/teacher'), name: 'Hacked', price: '1', accessDays: '365', curriculum: '', active: 'on' } })).status === 404);

    console.log('Bootcamp mentor carries the tutor\'s name');
    const tt = await tutor.c.csrf(`/teacher/cohorts/${cohortId}`);
    await tutor.c.req('POST', `/teacher/cohorts/${cohortId}`, { form: { _csrf: tt, name: 'Frontend Nov', price: '5000', accessDays: '30', curriculum: 'x', active: 'on', mentorName: 'Mr. Test' } });
    check('student sees "[tutor name]\'s AI Mentor"', /Mr\. Test’s/.test((await carol.c.req('GET', '/mentor')).text));

    console.log('Course Library (ADR-001)');
    const courses = (...a) => spawnSync('node', [path.join(__dirname, 'courses.js'), ...a], { env: process.env, encoding: 'utf8' });
    const daTrack = (await pool.query("SELECT id FROM tracks WHERE name = 'Data Analysis'")).rows[0].id;
    // Re-runnable on the same database: retire whatever an earlier run published.
    await pool.query(
      "UPDATE course_versions SET status = 'retired' WHERE status = 'published' AND course_id IN (SELECT id FROM courses WHERE track_id = $1 AND level = 'foundation' AND cohort_id IS NULL)",
      [daTrack]
    );
    const gen1 = courses('generate', 'Data Analysis', 'foundation');
    const v1 = Number(gen1.stdout.match(/draft version (\d+)/)?.[1]);
    check('courses.js generate builds a draft (8 per-week calls, mock AI)', gen1.status === 0 && Number.isInteger(v1), gen1.stdout + gen1.stderr);
    const v1row = (await pool.query('SELECT status, content, model FROM course_versions WHERE id = $1', [v1])).rows[0];
    check('draft is 8 weeks x 7 days and not yet published', v1row && v1row.status === 'draft' && v1row.content.weeks.length === 8
      && v1row.content.weeks.every((w) => w.days.length === 7) && v1row.model === 'mock');
    check('courses.js list shows the draft', /Data Analysis \/ foundation .*\[draft\]/.test(courses('list').stdout));

    const jobRunner = require('../services/jobRunner');
    const courseId = (await pool.query('SELECT course_id FROM course_versions WHERE id = $1', [v1])).rows[0].course_id;
    const [e1, e2] = await Promise.all([1, 2].map(() => jobRunner.enqueue('course_gen', { courseId: 0 }, { dedupeKey: `dedupe-test-${run}`, maxAttempts: 1 })));
    check('enqueue is idempotent on dedupe_key (one job for two calls)', e1.job.id === e2.job.id && e1.created !== e2.created);
    let failedJob;
    for (let i = 0; i < 20; i++) {
      await jobRunner.runOnce();
      failedJob = (await pool.query('SELECT status, attempts, last_error FROM jobs WHERE id = $1', [e1.job.id])).rows[0];
      if (failedJob.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    check('a failing job ends as failed with last_error after max_attempts', failedJob.status === 'failed' && failedJob.attempts === 1 && /not found/.test(failedJob.last_error), JSON.stringify(failedJob));

    const badDraft = (await pool.query(
      "INSERT INTO course_versions (course_id, version, status, content) VALUES ($1, 99, 'draft', $2) RETURNING id",
      [courseId, JSON.stringify({ weeks: [{ week_number: 1, focus: 'x', project: 'y', days: [] }] })]
    )).rows[0].id;
    const badPub = courses('publish', String(badDraft));
    check('publishing an invalid plan is refused', badPub.status !== 0 && (await pool.query('SELECT status FROM course_versions WHERE id = $1', [badDraft])).rows[0].status === 'draft');
    await pool.query('DELETE FROM course_versions WHERE id = $1', [badDraft]);

    const daUser = await makeUser('libfree');
    const dt0 = await daUser.c.csrf('/join');
    const courseModel = require('../models/courseModel');
    check('a draft is never offered to learners', !(await courseModel.findPublishedLibraryVersion(daTrack, 'foundation'))
      && (await courseModel.getVersionContent(v1)) === null);

    const pub1 = courses('publish', String(v1));
    check('courses.js publish publishes the draft', pub1.status === 0 && (await pool.query('SELECT status FROM course_versions WHERE id = $1', [v1])).rows[0].status === 'published', pub1.stdout + pub1.stderr);
    check('publishing twice is refused', courses('publish', String(v1)).status !== 0);
    check('published content is immutable (DB trigger)', await pool.query("UPDATE course_versions SET content = '{}' WHERE id = $1", [v1]).then(() => false, () => true));

    const sel = await daUser.c.req('POST', `/tracks/${daTrack}/select`, { form: { _csrf: dt0, goal: 'analyse sales for my shop' } });
    const libRoadmapId = Number((sel.location || '').match(/\/roadmaps\/(\d+)/)?.[1]);
    check('free user gets a library roadmap instantly (no AI key needed => 0 AI calls)', Number.isInteger(libRoadmapId), `${sel.status} ${sel.location}`);
    const libRow = (await pool.query('SELECT content, course_version_id, goal FROM roadmaps WHERE id = $1', [libRoadmapId])).rows[0];
    check('roadmap references the published version and stores no copy', libRow && libRow.content === null && libRow.course_version_id === v1 && libRow.goal === 'analyse sales for my shop');
    check('no AI usage recorded for the free user', (await pool.query('SELECT COUNT(*)::int n FROM ai_usage WHERE user_id = $1', [daUser.id])).rows[0].n === 0);
    check('selecting the track again reuses the same roadmap', (await daUser.c.req('POST', `/tracks/${daTrack}/select`, { form: { _csrf: dt0 } })).location === `/roadmaps/${libRoadmapId}`);

    const lp = await daUser.c.req('GET', `/roadmaps/${libRoadmapId}`);
    check('reader 1 (roadmap page) renders library content + templated intro', lp.status === 200 && /Library task W1D1/.test(lp.text)
      && /Day 1 of 56/.test(lp.text) && /class="library-intro"/.test(lp.text) && /analyse sales for my shop/.test(lp.text), lp.text.slice(0, 300));
    const ci = await daUser.c.req('POST', `/roadmaps/${libRoadmapId}/checkin`, { form: { _csrf: dt0, notes: 'did day 1 of the library plan' } });
    const libCoach = (await pool.query('SELECT cr.is_fallback FROM coach_responses cr JOIN checkins c ON c.id = cr.checkin_id WHERE c.roadmap_id = $1', [libRoadmapId])).rows[0];
    check('reader 2 (check-in flow) works on a library roadmap, template coach (no AI)', ci.location === `/roadmaps/${libRoadmapId}` && libCoach && libCoach.is_fallback === true, JSON.stringify(libCoach));
    check('roadmap page advances to day 2', /Library task W1D2/.test((await daUser.c.req('GET', `/roadmaps/${libRoadmapId}`)).text));
    const { currentTaskLine } = require('../controllers/mentorController');
    check('reader 3 (mentor currentTaskLine) reads library content', /Library task W1D2/.test(await currentTaskLine(daUser.id) || ''));
    const mig = spawnSync('node', [path.join(__dirname, 'migrateRoadmaps.js')], { env: NO_LLM_ENV, encoding: 'utf8' });
    check('reader 4 (migrateRoadmaps) skips library roadmaps', mig.status === 0 && mig.stdout.includes(`Roadmap ${libRoadmapId} uses the Course Library, skipping.`), mig.stdout.slice(-500) + mig.stderr);

    const gen2 = courses('generate', String(daTrack), 'foundation');
    const v2 = Number(gen2.stdout.match(/draft version (\d+)/)?.[1]);
    check('a second generate makes v2 as a new draft', gen2.status === 0 && Number.isInteger(v2) && v2 !== v1, gen2.stdout + gen2.stderr);
    courses('publish', String(v2));
    const statuses = (await pool.query('SELECT id, status FROM course_versions WHERE id = ANY($1)', [[v1, v2]])).rows;
    check('publishing v2 retires v1 (one published version per course)', statuses.find((r) => r.id === v1).status === 'retired' && statuses.find((r) => r.id === v2).status === 'published');
    check('existing learner stays pinned to v1 and still renders', (await pool.query('SELECT course_version_id FROM roadmaps WHERE id = $1', [libRoadmapId])).rows[0].course_version_id === v1
      && /Library task W1D2/.test((await daUser.c.req('GET', `/roadmaps/${libRoadmapId}`)).text));
    const daUser2 = await makeUser('libfree2');
    const sel2 = await daUser2.c.req('POST', `/tracks/${daTrack}/select`, { form: { _csrf: await daUser2.c.csrf('/join') } });
    const r2 = Number((sel2.location || '').match(/\/roadmaps\/(\d+)/)?.[1]);
    check('a new learner gets v2', (await pool.query('SELECT course_version_id FROM roadmaps WHERE id = $1', [r2])).rows[0]?.course_version_id === v2);
    check('library roadmap without a goal gets the no-goal intro', /Pick project topics you care about/.test((await daUser2.c.req('GET', `/roadmaps/${r2}`)).text));
    check('another learner cannot open the library roadmap', (await daUser2.c.req('GET', `/roadmaps/${libRoadmapId}`)).status === 404);
    check('course migration is idempotent (re-run succeeds)', spawnSync('node', [path.join(__dirname, 'migrateCourses.js')], { env: process.env, encoding: 'utf8' }).status === 0);

    console.log('LLM router (Phase 1)');
    const rita = await makeUser('rita');
    const rt = await rita.c.csrf('/join');
    check('rita joins the free bootcamp (mentor + AI coach access)', (await rita.c.req('POST', '/join', { form: { _csrf: rt, code: freeCode } })).location === '/mentor');
    const ritaRows = async () => (await pool.query('SELECT provider, task, ok, error_code, streamed, prompt_tokens, completion_tokens FROM llm_calls WHERE user_id = $1 ORDER BY id', [rita.id])).rows;
    const ritaUsage = async () => (await pool.query("SELECT COALESCE(SUM(count),0)::int n FROM ai_usage WHERE user_id = $1 AND kind = 'mentor'", [rita.id])).rows[0].n;
    const ask = (msg, id, url = '/mentor/message') => rita.c.req('POST', url, { json: { message: msg, clientMsgId: id }, headers: { 'x-csrf-token': rt } });
    const parseSse = (text) => text.split('\n\n').filter(Boolean).map((block) => {
      const ev = (block.match(/^event: (.+)$/m) || [])[1] || 'message';
      const data = (block.match(/^data: (.+)$/m) || [])[1];
      return { ev, data: data ? JSON.parse(data) : null };
    });

    // Everything down first: refunds keep rita's daily budget (3) intact for the rest.
    mock.reset();
    mock.setMode('groq', '500'); mock.setMode('gemini', '503');
    const downJson = await ask('anyone there?', crypto.randomBytes(8).toString('hex'));
    check('all providers down => 502 ai_unavailable (JSON)', downJson.status === 502 && JSON.parse(downJson.text).error === 'ai_unavailable');
    const downStream = await ask('anyone there?', crypto.randomBytes(8).toString('hex'), '/mentor/message/stream');
    const downEvents = parseSse(downStream.text);
    check('all providers down => stream ends with an error event', downStream.status === 200 && downEvents.some((e) => e.ev === 'error' && e.data.error === 'ai_unavailable'), downStream.text);
    check('failed turns are refunded and not saved', (await ritaUsage()) === 0
      && (await pool.query('SELECT COUNT(*)::int n FROM mentor_messages WHERE user_id = $1', [rita.id])).rows[0].n === 0);
    check('each failed attempt is logged (provider, code)', (await ritaRows()).filter((r) => !r.ok).map((r) => r.provider + r.error_code).join(',') === 'groq500,gemini503,groq500,gemini503');

    mock.reset();
    await pool.query('DELETE FROM llm_calls WHERE user_id = $1', [rita.id]);
    const rr1 = await ask('How do I centre a div?', crypto.randomBytes(8).toString('hex'));
    check('mentor reply comes from Groq through the router', rr1.status === 200 && /\[mock mentor\] You asked: "How do I centre a div\?"/.test(JSON.parse(rr1.text).reply), rr1.text);
    let rows = await ritaRows();
    check('llm_calls row: groq, mentor, ok, tokens', rows.length === 1 && rows[0].provider === 'groq' && rows[0].task === 'mentor' && rows[0].ok && rows[0].prompt_tokens === 11 && !rows[0].streamed);
    const sentToGroq = mock.requests[mock.requests.length - 1].body.messages;
    check('no student name or email reaches the provider', !JSON.stringify(sentToGroq).includes('rita') && !JSON.stringify(sentToGroq).includes('example.com'));
    check('student text goes in the user turn, not the system prompt', sentToGroq[0].role === 'system' && !sentToGroq[0].content.includes('centre a div')
      && sentToGroq[sentToGroq.length - 1].role === 'user' && sentToGroq[sentToGroq.length - 1].content.includes('centre a div'));
    const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'llm_calls'")).rows.map((c) => c.column_name);
    check('llm_calls has no column for prompt or reply text', !cols.some((c) => /^prompt$|content|reply|message|text/.test(c)), cols.join(','));

    mock.setMode('groq', '429');
    const rr2 = await ask('And flexbox?', crypto.randomBytes(8).toString('hex'));
    rows = await ritaRows();
    check('Groq 429 => Gemini answers', rr2.status === 200 && JSON.parse(rr2.text).reply.includes('And flexbox?') && rows.slice(-2).map((r) => r.provider + ':' + (r.ok ? 'ok' : r.error_code)).join(',') === 'groq:429,gemini:ok');
    mock.reset();

    const streamId = crypto.randomBytes(8).toString('hex');
    const s1 = await ask('Explain grid please', streamId, '/mentor/message/stream');
    const events = parseSse(s1.text);
    const streamed = events.filter((e) => e.ev === 'message').map((e) => e.data.delta).join('');
    check('stream endpoint answers with server-sent events', s1.status === 200 && /text\/event-stream/.test(s1.res.headers.get('content-type') || ''));
    check('stream delivers the reply in several chunks, then done', events.filter((e) => e.ev === 'message').length > 1 && /Explain grid please/.test(streamed)
      && events[events.length - 1].ev === 'done' && events[events.length - 1].data.remainingToday === 0, s1.text.slice(0, 300));
    check('streamed reply saved to history', (await rita.c.req('GET', '/mentor')).text.includes('Explain grid please'));
    rows = await ritaRows();
    check('streamed call logged with streamed = true', rows[rows.length - 1].streamed === true && rows[rows.length - 1].ok);
    const replay = await ask('Explain grid please', streamId, '/mentor/message/stream');
    check('stream replay of the same clientMsgId returns the stored reply as JSON (not billed)', replay.status === 200 && JSON.parse(replay.text).replayed === true
      && JSON.parse(replay.text).reply === streamed.trim() && (await ritaUsage()) === 3);
    const capped2 = await ask('one more', crypto.randomBytes(8).toString('hex'), '/mentor/message/stream');
    check('stream endpoint enforces the daily cap (429 JSON)', capped2.status === 429 && JSON.parse(capped2.text).error === 'daily_limit');
    check('stream endpoint requires CSRF', (await rita.c.req('POST', '/mentor/message/stream', { json: { message: 'x', clientMsgId: crypto.randomBytes(8).toString('hex') } })).status === 403);
    check('free user cannot use the stream endpoint (402)', (await fred.c.req('POST', '/mentor/message/stream', { json: { message: 'x', clientMsgId: crypto.randomBytes(8).toString('hex') }, headers: { 'x-csrf-token': await fred.c.csrf('/join') } })).status === 402);

    const rrm = await pool.query("INSERT INTO roadmaps (user_id, track_id, goal, content) VALUES ($1, 1, 'get hired', $2) RETURNING id",
      [rita.id, JSON.stringify({ weeks: [{ focus: 'Basics', project: 'P', days: [{ task: 'Day 1 task' }, { task: 'Day 2 task' }] }] })]);
    mock.reset();
    await rita.c.req('POST', `/roadmaps/${rrm.rows[0].id}/checkin`, { form: { _csrf: rt, notes: 'learned semantic tags today' } });
    const rcoach = (await pool.query('SELECT cr.* FROM coach_responses cr JOIN checkins c ON c.id = cr.checkin_id WHERE c.roadmap_id = $1', [rrm.rows[0].id])).rows[0];
    check('paid check-in coach goes through the router (Groq, JSON)', rcoach && rcoach.is_fallback === false && /mock coach:groq/.test(rcoach.acknowledgement), JSON.stringify(rcoach));
    const coachReq = mock.requests.find((q) => q.body.response_format);
    check('coach: notes in the user turn, JSON schema requested', coachReq && !coachReq.body.messages[0].content.includes('semantic tags')
      && coachReq.body.messages[1].content.includes('semantic tags') && coachReq.body.response_format.type === 'json_schema');
    check('coach call logged as task checkin', (await ritaRows()).some((r) => r.task === 'checkin' && r.ok));
    mock.setMode('groq', '500'); mock.setMode('gemini', '500');
    const rrm2 = await pool.query('INSERT INTO roadmaps (user_id, track_id, content) VALUES ($1, 2, $2) RETURNING id',
      [rita.id, JSON.stringify({ weeks: [{ focus: 'B', days: [{ task: 'T1' }, { task: 'T2' }] }] })]);
    await rita.c.req('POST', `/roadmaps/${rrm2.rows[0].id}/checkin`, { form: { _csrf: rt, notes: 'second roadmap' } });
    check('coach falls back to the template when every provider fails', (await pool.query('SELECT cr.is_fallback FROM coach_responses cr JOIN checkins c ON c.id = cr.checkin_id WHERE c.roadmap_id = $1', [rrm2.rows[0].id])).rows[0]?.is_fallback === true);
    mock.reset();

    console.log('Voice: speech-to-text endpoint');
    const clip = (kind, size = 4000) => {
      const head = kind === 'webm' ? Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
        : kind === 'ogg' ? Buffer.from('OggS', 'latin1')
        : kind === 'mp4' ? Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A ', 'latin1')])
        : Buffer.from('RIFF', 'latin1');
      return Buffer.concat([head, Buffer.alloc(size - head.length, 3)]);
    };
    const svt = await fred.c.csrf('/join');
    const sendClip = (c, body, type, token = svt) => c.req('POST', '/api/voice/transcribe', { raw: body, headers: { 'content-type': type, ...(token ? { 'x-csrf-token': token } : {}) } });
    const sttUsage = async (id) => (await pool.query("SELECT COALESCE(SUM(count),0)::int n FROM ai_usage WHERE user_id = $1 AND kind = 'stt'", [id])).rows[0].n;

    const anon = client();
    const anonToken = await anon.csrf('/login');
    check('voice: not logged in => 401', (await anon.req('POST', '/api/voice/transcribe', { raw: clip('webm'), headers: { 'content-type': 'audio/webm', 'x-csrf-token': anonToken } })).status === 401);
    check('voice: missing CSRF header => 403', (await sendClip(fred.c, clip('webm'), 'audio/webm', null)).status === 403);
    const sv1 = await sendClip(fred.c, clip('webm'), 'audio/webm;codecs=opus');
    check('voice: free user can transcribe (Groq Whisper via router)', sv1.status === 200 && JSON.parse(sv1.text).text === '[mock transcript:groq]', sv1.text);
    check('voice: the clip reached Whisper as audio/webm multipart', mock.requests.some((q) => q.kind === 'transcription' && q.raw.includes('clip.webm') && q.raw.includes('whisper-large-v3-turbo')));
    check('voice: usage counted (kind stt) and logged', (await sttUsage(fred.id)) === 1
      && (await pool.query("SELECT COUNT(*)::int n FROM llm_calls WHERE user_id = $1 AND task = 'stt' AND ok", [fred.id])).rows[0].n === 1);
    check('voice: response is not cacheable', /no-store/.test(sv1.res.headers.get('cache-control') || ''));
    check('voice: wrong type (wav) => 415', (await sendClip(fred.c, clip('wav'), 'audio/wav')).status === 415);
    check('voice: bytes that do not match the claimed type => 415', (await sendClip(fred.c, clip('wav'), 'audio/webm')).status === 415);
    check('voice: over STT_MAX_BYTES => 413', (await sendClip(fred.c, clip('webm', 60000), 'audio/webm')).status === 413);
    check('voice: tiny clip => 400 too_short', JSON.parse((await sendClip(fred.c, clip('webm', 500), 'audio/webm')).text).error === 'too_short');
    check('voice: rejected uploads are not counted', (await sttUsage(fred.id)) === 1);
    check('voice: iOS mp4 clip accepted', JSON.parse((await sendClip(fred.c, clip('mp4'), 'audio/mp4')).text).text === '[mock transcript:groq]');
    check('voice: ogg clip accepted', (await sendClip(fred.c, clip('ogg'), 'audio/ogg')).status === 200);
    mock.setMode('groq', '503'); mock.setMode('gemini', '500');
    const svd = await sendClip(fred.c, clip('webm'), 'audio/webm');
    check('voice: every provider down => 502 stt_unavailable, refunded', svd.status === 502 && JSON.parse(svd.text).error === 'stt_unavailable' && (await sttUsage(fred.id)) === 3);
    mock.reset();
    mock.setMode('groq', '503');
    const svf = await sendClip(fred.c, clip('webm'), 'audio/webm');
    check('voice: Groq down => Gemini transcribes', svf.status === 200 && JSON.parse(svf.text).text === '[mock transcript:gemini]', svf.text);
    mock.reset();
    const svc = await sendClip(fred.c, clip('webm'), 'audio/webm');
    check('voice: free daily cap (STT_DAILY_LIMIT_FREE=4) => 429 daily_limit', svc.status === 429 && JSON.parse(svc.text).error === 'daily_limit');
    const svr = await sendClip(rita.c, clip('webm'), 'audio/webm', rt);
    check('voice: paid user gets the paid cap (6)', svr.status === 200 && JSON.parse(svr.text).remainingToday === 5, svr.text);
    check('voice: no table stores raw audio (no bytea columns)', (await pool.query("SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'bytea'")).rows[0].n === 0);

    console.log('Voice: pages');
    const dash = await pam.c.req('GET', '/dashboard');
    check('goal box has the voice recorder (no inline speech script)', dash.text.includes('data-voice-target="goalInput"') && dash.text.includes('/js/voice.js') && !dash.text.includes('webkitSpeechRecognition'));
    const fredRoadmap = (await pool.query('SELECT id FROM roadmaps WHERE user_id = $1 LIMIT 1', [fred.id])).rows[0].id;
    const rpage = await fred.c.req('GET', `/roadmaps/${fredRoadmap}`);
    check('check-in box has the voice recorder', rpage.text.includes('data-voice-target="checkinNotes"') && rpage.text.includes('/js/voice.js') && !rpage.text.includes('webkitSpeechRecognition'));
    check('coach card can be read aloud', /class="app-card coach-card" data-tts/.test(rpage.text));
    const mpage = await rita.c.req('GET', '/mentor');
    check('mentor has voice input and the read-aloud preference', mpage.text.includes('data-voice-target="msg"') && mpage.text.includes('id="readAloud"') && mpage.text.includes('/js/voice.js'));
    const vjs = await fred.c.req('GET', '/js/voice.js');
    check('voice.js is served', vjs.status === 200 && vjs.text.includes('/api/voice/transcribe'));
    mock.reset();
  } finally {
    await mock.close();
    server.kill();
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('\n--- server log ---\n' + serverLog.slice(-3000)); process.exit(1); }
}

main().catch((err) => { console.error('TEST CRASHED:', err); process.exit(1); });
