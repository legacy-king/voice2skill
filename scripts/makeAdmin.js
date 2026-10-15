#!/usr/bin/env node
/**
 * Grants (or revokes) the founder admin view (/admin) for an existing, verified user.
 *
 * Usage: node scripts/makeAdmin.js <email> [--revoke]
 */
const pool = require('../config/db');

async function main() {
  const args = process.argv.slice(2);
  const email = (args.find((a) => !a.startsWith('--')) || '').trim().toLowerCase();
  const revoke = args.includes('--revoke');
  if (!email) {
    console.error('Usage: node scripts/makeAdmin.js <email> [--revoke]');
    process.exit(1);
  }
  const { rows } = await pool.query('SELECT id, name, email_verified FROM users WHERE email = $1', [email]);
  if (!rows[0]) throw new Error(`No user with email ${email}.`);
  if (!revoke && !rows[0].email_verified) throw new Error(`${email} has not verified their email yet.`);
  await pool.query('UPDATE users SET is_admin = $2 WHERE id = $1', [rows[0].id, !revoke]);
  console.log(revoke ? `✓ ${rows[0].name} is no longer an admin.` : `✓ ${rows[0].name} can now open /admin.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('Failed:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
