const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // DATABASE_SSL=false is for a local Postgres only; hosted DBs (Neon) need SSL.
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX) || 10
});

/*pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Connection failed:', err);
  } else {
    console.log('Connected to Neon at:', res.rows[0].now);
  }
  process.exit();
});*/

module.exports = pool;