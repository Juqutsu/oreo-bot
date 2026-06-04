const { getPool } = require('./db');

/**
 * Liest die Config-Row einer Guild aus `guilds`.
 * @param {string} guildId
 * @returns {Promise<{mod_log_channel_id: string|null, report_channel_id: string|null, automod_enabled: number}|null>}
 */
async function readGuildRow(guildId) {
  const [rows] = await getPool().execute(
    'SELECT mod_log_channel_id, report_channel_id, msg_log_channel_id, min_account_age_days, warn_decay_days, muted_role_id, automod_enabled FROM guilds WHERE guild_id = ?',
    [guildId],
  );
  return rows[0] ?? null;
}

/**
 * Liefert die mod-log-channel-ID für eine Guild.
 * Reihenfolge: 1) guilds.mod_log_channel_id, 2) process.env.MODLOG_CHANNEL_ID, 3) null.
 * @param {string} guildId
 * @returns {Promise<string|null>}  Snowflake-String oder null wenn nicht konfiguriert
 */
async function getModLogChannelId(guildId) {
  const row = await readGuildRow(guildId);
  const dbValue = row?.mod_log_channel_id ?? null;
  if (dbValue) return String(dbValue);
  return process.env.MODLOG_CHANNEL_ID || null;
}

/**
 * Liefert die report-channel-ID. Kein env-Fallback.
 * @param {string} guildId
 * @returns {Promise<string|null>}
 */
async function getReportChannelId(guildId) {
  const row = await readGuildRow(guildId);
  return row?.report_channel_id ? String(row.report_channel_id) : null;
}

/**
 * Liefert ob automod für die Guild aktiviert ist. Default: false.
 * @param {string} guildId
 * @returns {Promise<boolean>}
 */
async function isAutomodEnabled(guildId) {
  const row = await readGuildRow(guildId);
  return Boolean(row?.automod_enabled);
}

/**
 * Liefert die msg-log-channel-ID. Kein env-Fallback.
 * @param {string} guildId
 * @returns {Promise<string|null>}
 */
async function getMsgLogChannelId(guildId) {
  const row = await readGuildRow(guildId);
  return row?.msg_log_channel_id ? String(row.msg_log_channel_id) : null;
}

/**
 * Liefert die Mindest-Account-Altersschwelle in Tagen. Default: 0 (deaktiviert).
 * @param {string} guildId
 * @returns {Promise<number>}
 */
async function getMinAccountAgeDays(guildId) {
  const row = await readGuildRow(guildId);
  return row?.min_account_age_days ? Number(row.min_account_age_days) : 0;
}

/**
 * Liefert die Dauer in Tagen, nach denen eine Verwarnung verfällt. Default: 0 (deaktiviert).
 * @param {string} guildId
 * @returns {Promise<number>}
 */
async function getWarnDecayDays(guildId) {
  const row = await readGuildRow(guildId);
  return row?.warn_decay_days ? Number(row.warn_decay_days) : 0;
}

/**
 * Liefert die ID der Mute-Rolle.
 * @param {string} guildId
 * @returns {Promise<string|null>}
 */
async function getMutedRoleId(guildId) {
  const row = await readGuildRow(guildId);
  return row?.muted_role_id ? String(row.muted_role_id) : null;
}

/**
 * Speichert die ID der Mute-Rolle in der Konfiguration.
 * @param {string} guildId
 * @param {string} roleId
 * @returns {Promise<void>}
 */
async function setMutedRoleId(guildId, roleId) {
  await getPool().execute(
    'UPDATE guilds SET muted_role_id = ? WHERE guild_id = ?',
    [roleId, guildId]
  );
}

module.exports = {
  getModLogChannelId,
  getReportChannelId,
  getMsgLogChannelId,
  getMinAccountAgeDays,
  getWarnDecayDays,
  getMutedRoleId,
  setMutedRoleId,
  isAutomodEnabled,
};
