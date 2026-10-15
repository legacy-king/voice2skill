#!/usr/bin/env node
/**
 * Registers a bootcamp (organization) and makes an existing user its owner/teacher.
 * The tutor must have already signed up and verified their email.
 *
 * Usage: node scripts/createOrg.js "<Bootcamp name>" <tutor-email> [sharePct=20] [net|gross=net]
 * Example: node scripts/createOrg.js "Tunde's Code Academy" tunde@example.com 20 net
 */
const pool = require('../config/db');

async function main() {
  const [name, email, pctArg = '20', basis = 'net'] = process.argv.slice(2);
  if (!name || !email) {
    console.error('Usage: node scripts/createOrg.js "<name>" <tutor-email> [sharePct=20] [net|gross=net]');
    process.exit(1);
  }
  const pct = Number(pctArg);
  if (!(pct >= 0 && pct <= 100)) throw new Error('sharePct must be between 0 and 100');
  if (!['net', 'gross'].includes(basis)) throw new Error("basis must be 'net' or 'gross'");

  const { rows } = await pool.query('SELECT id, name FROM users WHERE email = $1', [email.trim().toLowerCase()]);
  if (!rows[0]) throw new Error(`No user with email ${email}. Ask them to sign up and verify first.`);

  const dup = await pool.query('SELECT id FROM organizations WHERE owner_user_id = $1', [rows[0].id]);
  if (dup.rowCount) throw new Error(`${email} already owns organization #${dup.rows[0].id}`);

  const org = await pool.query(
    'INSERT INTO organizations (name, owner_user_id, revenue_share_pct, share_basis) VALUES ($1,$2,$3,$4) RETURNING id',
    [name, rows[0].id, pct, basis]
  );
  await pool.query("UPDATE users SET role = 'teacher' WHERE id = $1", [rows[0].id]);
  console.log(`✓ Organization #${org.rows[0].id} "${name}" created. ${rows[0].name} is now a teacher.`);
  console.log(`  Revenue share: ${pct}% of ${basis === 'net' ? 'amount after Paystack fees' : 'the amount paid'}.`);
  console.log('  They can now log in and open /teacher to create their first cohort.');
  await pool.end();
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
