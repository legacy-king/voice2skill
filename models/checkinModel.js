const pool = require('../config/db');


async function createCheckin(user_id, roadmap_id, notes) {
    const result = await pool.query(
'INSERT INTO checkins (user_id, roadmap_id, notes) VALUES ($1, $2, $3) RETURNING *',
[user_id, roadmap_id, notes]
    );
    return result.rows[0];
}

async function getCheckinsByRoadmap(userId, roadmapId) {
    const result = await pool.query(
        'SELECT * FROM checkins WHERE user_id = $1 AND roadmap_id = $2',
        [userId, roadmapId]
    )
    return result.rows;
}

async function getCheckinByDate(userId, roadmapId, date) {
    const result = await pool.query(
      'SELECT * FROM checkins WHERE user_id = $1 AND roadmap_id = $2 AND checkin_date = $3',
        [userId, roadmapId, date]
    )
   return result.rows[0];
}

module.exports = { createCheckin, getCheckinsByRoadmap, getCheckinByDate};