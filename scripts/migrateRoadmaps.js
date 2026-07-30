const roadmapModel = require('../models/roadmapModel');
const trackModel = require('../models/trackModel');
const { generateRoadmapContent } = require('../controllers/roadmapController');
const pool = require('../config/db');

async function migrateOldRoadmaps() {
  const result = await pool.query('SELECT * FROM roadmaps');
  const allRoadmaps = result.rows;

  for (const roadmap of allRoadmaps) {
    const isOldFormat = roadmap.content.weeks[0]?.daily_topics !== undefined;

    if (isOldFormat) {
      console.log(`Migrating roadmap ${roadmap.id}...`);

      try {
        const track = await trackModel.getTrackById(roadmap.track_id);
        const newContent = await generateRoadmapContent(track.name, track.description);

        await pool.query(
          'UPDATE roadmaps SET content = $1 WHERE id = $2',
          [newContent, roadmap.id]
        );

        console.log(`Roadmap ${roadmap.id} updated.`);
      } catch (err) {
        console.error(`Failed to migrate roadmap ${roadmap.id}:`, err.message);
        console.log(`Skipping roadmap ${roadmap.id}, will need to retry later.`);
      }
    } else {
      console.log(`Roadmap ${roadmap.id} already up to date, skipping.`);
    }
  }

  console.log('Migration complete.');
  process.exit();
}

migrateOldRoadmaps();