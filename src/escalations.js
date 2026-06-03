const { getPool } = require('./db');

/**
 * Liefert die Eskalations-Regel für eine exakte Warn-Schwelle.
 * @param {string} guildId
 * @param {number} threshold
 * @returns {Promise<object|null>} { id, guild_id, warn_threshold, action, duration_minutes } oder null
 */
async function getRuleForThreshold(guildId, threshold) {
  const [rows] = await getPool().execute(
    `SELECT id, guild_id, warn_threshold, action, duration_minutes
       FROM escalation_rules
      WHERE guild_id = ? AND warn_threshold = ?
      LIMIT 1`,
    [guildId, threshold],
  );
  return rows[0] ?? null;
}

/**
 * Listet alle Eskalations-Regeln einer Guild, sortiert nach Schwelle aufsteigend.
 * @param {string} guildId
 * @returns {Promise<object[]>}
 */
async function listRules(guildId) {
  const [rows] = await getPool().execute(
    `SELECT id, warn_threshold, action, duration_minutes
       FROM escalation_rules
      WHERE guild_id = ?
      ORDER BY warn_threshold ASC`,
    [guildId],
  );
  return rows;
}

/**
 * Setzt oder aktualisiert eine Eskalations-Regel (UPSERT auf uq_threshold_per_guild).
 * @param {string} guildId
 * @param {number} threshold
 * @param {'timeout'|'kick'|'ban'} action
 * @param {number|null} durationMinutes  (nur bei action='timeout' relevant; sonst null)
 * @returns {Promise<void>}
 */
async function setRule(guildId, threshold, action, durationMinutes) {
  await getPool().execute(
    `INSERT INTO escalation_rules (guild_id, warn_threshold, action, duration_minutes)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE action = VALUES(action), duration_minutes = VALUES(duration_minutes)`,
    [guildId, threshold, action, durationMinutes],
  );
}

/**
 * Entfernt eine Eskalations-Regel.
 * @param {string} guildId
 * @param {number} threshold
 * @returns {Promise<number>} affectedRows (0 wenn keine Regel existierte)
 */
async function removeRule(guildId, threshold) {
  const [result] = await getPool().execute(
    `DELETE FROM escalation_rules WHERE guild_id = ? AND warn_threshold = ?`,
    [guildId, threshold],
  );
  return result.affectedRows;
}

module.exports = {
  getRuleForThreshold,
  listRules,
  setRule,
  removeRule,
};
