function calculateStreak(checkins) {
  if (checkins.length === 0) return 0;

  const dates = checkins
    .map(c => c.checkin_date.toISOString().split('T')[0])
    .sort()
    .reverse();

  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  if (dates[0] !== today && dates[0] !== yesterday) {
    return 0;
  }

  let streak = 1;
  for (let i = 0; i < dates.length - 1; i++) {
    const current = new Date(dates[i]);
    const next = new Date(dates[i + 1]);
    const dayDiff = (current - next) / 86400000;

    if (dayDiff === 1) {
      streak++;
    } else {
      break;
    }
  }

  return streak;
}

module.exports = { calculateStreak };