const { getPool } = require('./db');

/**
 * Liest die Config-Row einer Guild aus `guilds`.
 * @param {string} guildId
 * @returns {Promise<{mod_log_channel_id: string|null, report_channel_id: string|null, automod_enabled: number}|null>}
 */
async function readGuildRow(guildId) {
  const [rows] = await getPool().execute(
    'SELECT mod_log_channel_id, report_channel_id, msg_log_channel_id, min_account_age_days, warn_decay_days, muted_role_id, automod_enabled, captcha_enabled, verified_role_id, toxicity_enabled, toxicity_action FROM guilds WHERE guild_id = ?',
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

/**
 * Liefert ob die Captcha-Verifizierung aktiviert ist.
 */
async function getCaptchaEnabled(guildId) {
  const row = await readGuildRow(guildId);
  return Boolean(row?.captcha_enabled);
}

/**
 * Setzt ob die Captcha-Verifizierung aktiviert ist.
 */
async function setCaptchaEnabled(guildId, enabled) {
  await getPool().execute(
    'UPDATE guilds SET captcha_enabled = ? WHERE guild_id = ?',
    [enabled ? 1 : 0, guildId]
  );
}

/**
 * Liefert die verifizierte Rolle.
 */
async function getVerifiedRoleId(guildId) {
  const row = await readGuildRow(guildId);
  return row?.verified_role_id ? String(row.verified_role_id) : null;
}

/**
 * Setzt die verifizierte Rolle.
 */
async function setVerifiedRoleId(guildId, roleId) {
  await getPool().execute(
    'UPDATE guilds SET verified_role_id = ? WHERE guild_id = ?',
    [roleId || null, guildId]
  );
}

/**
 * Liefert ob der Toxizitätsfilter aktiviert ist.
 */
async function getToxicityEnabled(guildId) {
  const row = await readGuildRow(guildId);
  return Boolean(row?.toxicity_enabled);
}

/**
 * Setzt ob der Toxizitätsfilter aktiviert ist.
 */
async function setToxicityEnabled(guildId, enabled) {
  await getPool().execute(
    'UPDATE guilds SET toxicity_enabled = ? WHERE guild_id = ?',
    [enabled ? 1 : 0, guildId]
  );
}

/**
 * Liefert die Toxizitäts-Aktion ('delete', 'warn', 'mute').
 */
async function getToxicityAction(guildId) {
  const row = await readGuildRow(guildId);
  return row?.toxicity_action ?? 'warn';
}

/**
 * Setzt die Toxizitäts-Aktion.
 */
async function setToxicityAction(guildId, action) {
  await getPool().execute(
    'UPDATE guilds SET toxicity_action = ? WHERE guild_id = ?',
    [action, guildId]
  );
}

/**
 * Liefert die Liste aller Bad Words einer Guild.
 */
async function getBadWords(guildId) {
  const [rows] = await getPool().execute(
    'SELECT word FROM bad_words WHERE guild_id = ? ORDER BY word ASC',
    [guildId]
  );
  return rows.map((r) => r.word);
}

/**
 * Fügt ein Bad Word hinzu (idempotent).
 */
async function addBadWord(guildId, word) {
  const cleanWord = word.trim().toLowerCase();
  if (!cleanWord) return;
  await getPool().execute(
    'INSERT IGNORE INTO bad_words (guild_id, word) VALUES (?, ?)',
    [guildId, cleanWord]
  );
}

/**
 * Entfernt ein Bad Word.
 */
async function removeBadWord(guildId, word) {
  const cleanWord = word.trim().toLowerCase();
  await getPool().execute(
    'DELETE FROM bad_words WHERE guild_id = ? AND word = ?',
    [guildId, cleanWord]
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
  getCaptchaEnabled,
  setCaptchaEnabled,
  getVerifiedRoleId,
  setVerifiedRoleId,
  getToxicityEnabled,
  setToxicityEnabled,
  getToxicityAction,
  setToxicityAction,
  getBadWords,
  addBadWord,
  removeBadWord,
};

