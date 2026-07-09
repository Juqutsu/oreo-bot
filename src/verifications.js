const { getPool } = require('./db');

/** Merkt einen unverifizierten Join vor. Deadline wird DB-seitig berechnet. */
async function trackJoin(guildId, userId, channelId, minutes) {
  await getPool().execute(
    `INSERT INTO pending_verifications (guild_id, user_id, channel_id, deadline_at)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))
     ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), deadline_at = VALUES(deadline_at)`,
    [guildId, userId, channelId, minutes],
  );
}

/** Entfernt den Pending-Eintrag (Captcha gelöst ODER User gekickt/weg). */
async function markVerified(guildId, userId) {
  await getPool().execute(
    'DELETE FROM pending_verifications WHERE guild_id = ? AND user_id = ?',
    [guildId, userId],
  );
}

const remove = markVerified;

/** Alle Einträge, deren Deadline überschritten ist. */
async function listExpired() {
  const [rows] = await getPool().execute(
    'SELECT guild_id, user_id, channel_id FROM pending_verifications WHERE deadline_at < NOW()',
  );
  return rows;
}

module.exports = { trackJoin, markVerified, remove, listExpired };
