#!/usr/bin/env node
/**
 * End-to-end test of the cohort / payment / mentor / teacher flows.
 * Boots the real server against a real Postgres and drives it over HTTP.
 *
 * Needs: DATABASE_URL pointing at a DISPOSABLE database with `npm run migrate` already applied.
 * Uses mock Paystack + mock AI, so it costs nothing and needs no keys.
 *
 * Usage: DATABASE_URL=... DATABASE_SSL=false npm run test:cohorts
 */
process.env.PAYSTACK_MOCK = '1';
process.env.MENTOR_MOCK = '1';
process.env.EMAIL_MODE = 'log';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_cohort_suite';
process.env.SESSION_SECRET = 'test-secret';
process.env.MENTOR_DAILY_LIMIT = '3';
process.env.NODE_ENV = 'test';

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const pool = require('../config/db');

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
    const m = r.text.match(/name="_csrf" value="([a-f0-9]+)"/) || r.text.match(/const csrf = "([a-f0-9]+)"/) || r.text.match(/var csrf = "([a-f0-9]+)"/);
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
  } finally {
    server.kill();
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('\n--- server log ---\n' + serverLog.slice(-3000)); process.exit(1); }
}

main().catch((err) => { console.error('TEST CRASHED:', err); process.exit(1); });
