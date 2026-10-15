#!/usr/bin/env node
/**
 * Who is owed what. Also records bank-transfer payouts.
 *
 * Usage:
 *   node scripts/ledger.js                          # all bootcamps
 *   node scripts/ledger.js payout <orgId> <naira> ["note"]   # record a payout you just sent
 */
const pool = require('../config/db');
const { naira } = require('../utils/format');

async function main() {
  const [cmd, orgIdArg, amountArg, note] = process.argv.slice(2);

  if (cmd === 'payout') {
    const orgId = Number.parseInt(orgIdArg, 10);
    const kobo = Math.round(Number(amountArg) * 100);
    if (!Number.isInteger(orgId) || !Number.isInteger(kobo) || kobo <= 0) {
      throw new Error('Usage: node scripts/ledger.js payout <orgId> <naira> ["note"]');
    }
    await pool.query('INSERT INTO org_payouts (org_id, amount_kobo, note) VALUES ($1,$2,$3)', [orgId, kobo, note || null]);
    console.log(`✓ Recorded payout of ${naira(kobo)} to org #${orgId}.`);
  }

  const { rows } = await pool.query(`
    SELECT o.id, o.name, o.revenue_share_pct, o.share_basis,
      COALESCE((SELECT SUM(amount_kobo) FROM payments p WHERE p.org_id = o.id AND p.status = 'success'), 0)::bigint AS gross,
      COALESCE((SELECT SUM(provider_fee_kobo) FROM payments p WHERE p.org_id = o.id AND p.status = 'success'), 0)::bigint AS fees,
      COALESCE((SELECT SUM(org_share_kobo) FROM payments p WHERE p.org_id = o.id AND p.status = 'success'), 0)::bigint AS share,
      COALESCE((SELECT SUM(amount_kobo) FROM org_payouts q WHERE q.org_id = o.id), 0)::bigint AS paid
    FROM organizations o ORDER BY o.id`);
  if (!rows.length) console.log('No organizations yet.');
  for (const r of rows) {
    const gross = Number(r.gross), fees = Number(r.fees), share = Number(r.share), paid = Number(r.paid);
    console.log(`\n#${r.id} ${r.name}  (${Number(r.revenue_share_pct)}% of ${r.share_basis})`);
    console.log(`  collected ${naira(gross)} | paystack fees ${naira(fees)} | bootcamp share ${naira(share)} | paid out ${naira(paid)}`);
    console.log(`  OWED TO BOOTCAMP: ${naira(share - paid)}   |   YOUR GROSS REVENUE (before AI/hosting costs): ${naira(gross - fees - share)}`);
  }
  await pool.end();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
