const pool = require('../config/db');

async function getAllTracks() {
    const result = await pool.query(
        'SELECT * FROM tracks'
    );
    return result.rows;
}

async function getTrackById(id) {
         const result = await pool.query(
      'SELECT * FROM tracks WHERE id = $1',
      [id]
    )
    return result.rows[0];
}

module.exports = { getAllTracks, getTrackById};