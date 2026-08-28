const pool = require('../config/db');

async function migrate() {
  await pool.query(`ALTER TABLE roadmaps ADD COLUMN IF NOT EXISTS is_cached BOOLEAN NOT NULL DEFAULT FALSE`);
  console.log('✓ roadmaps.is_cached column ensured.');
  process.exit();
}
migrate();