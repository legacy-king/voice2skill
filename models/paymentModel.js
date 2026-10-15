const pool = require('../config/db');
const { log } = require('../utils/log');

async function createPending({ userId, cohortId, orgId, reference, amountKobo }) {
  const { rows } = await pool.query(
    `INSERT INTO payments (user_id, cohort_id, org_id, reference, amount_kobo)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, cohortId, orgId, reference, amountKobo]
  );
  return rows[0];
}

async function getByReference(reference) {
  const { rows } = await pool.query('SELECT * FROM payments WHERE reference = $1', [reference]);
  return rows[0];
}

/**
 * Settle a payment from Paystack transaction data. THE ONLY place access is granted for money.
 *
 * Idempotent: called by the webhook, the browser callback, or both, any number of times, in any
 * order, concurrently — the row lock + status check guarantee access is extended exactly once.
 * Never trusts the amount in the browser: it must equal what we stored when checkout started.
 *
 * @param {string} reference
 * @param {{status:string, amount?:number, currency?:string, fees?:number}} ps Paystack `data` object
 * @returns {Promise<{ok:boolean, already?:boolean, reason?:string, payment?:object}>}
 */
async function settlePayment(reference, ps) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT p.*, c.access_days, o.revenue_share_pct, o.share_basis
         FROM payments p
         JOIN cohorts c ON c.id = p.cohort_id
         JOIN organizations o ON o.id = p.org_id
        WHERE p.reference = $1
        FOR UPDATE OF p`,
      [reference]
    );
    const p = rows[0];
    if (!p) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'unknown_reference' };
    }
    if (p.status === 'success') {
      await client.query('COMMIT');
      return { ok: true, already: true, payment: p };
    }
    if (ps.status !== 'success') {
      if (ps.status === 'failed') await client.query("UPDATE payments SET status = 'failed' WHERE id = $1", [p.id]);
      await client.query('COMMIT');
      return { ok: false, reason: ps.status === 'failed' ? 'failed' : 'not_paid_yet', payment: p };
    }
    if (Number(ps.amount) !== p.amount_kobo || (ps.currency && ps.currency !== 'NGN')) {
      await client.query('ROLLBACK');
      log.error(`[payments] AMOUNT MISMATCH ref=${reference} expected=${p.amount_kobo} got=${ps.amount} ${ps.currency}`);
      return { ok: false, reason: 'amount_mismatch', payment: p };
    }

    const fee = Math.max(0, Number(ps.fees) || 0);
    const base = p.share_basis === 'net' ? p.amount_kobo - fee : p.amount_kobo;
    const orgShare = Math.max(0, Math.round((base * Number(p.revenue_share_pct)) / 100));

    await client.query(
      `UPDATE payments SET status = 'success', provider_fee_kobo = $2, org_share_kobo = $3, paid_at = NOW()
        WHERE id = $1`,
      [p.id, fee, orgShare]
    );
    // Extend from the later of (now, current expiry) so renewing early never wastes paid days.
    await client.query(
      `INSERT INTO memberships (user_id, cohort_id, role, status, access_until)
       VALUES ($1, $2, 'student', 'active', NOW() + make_interval(days => $3))
       ON CONFLICT (user_id, cohort_id) DO UPDATE
         SET status = 'active',
             access_until = GREATEST(COALESCE(memberships.access_until, NOW()), NOW())
                            + make_interval(days => $3)`,
      [p.user_id, p.cohort_id, p.access_days]
    );
    await client.query('COMMIT');
    return { ok: true, payment: { ...p, status: 'success', provider_fee_kobo: fee, org_share_kobo: orgShare } };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createPending, getByReference, settlePayment };
