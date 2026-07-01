const { getPool } = require('./db');

/**
 * Liest die Config-Row einer Guild aus `guilds`.
 * @param {string} guildId
 * @returns {Promise<{mod_log_channel_id: string|null, report_channel_id: string|null, automod_enabled: number}|null>}
 */
async function readGuildRow(guildId) {
  const [rows] = await getPool().execute(
    'SELECT mod_log_channel_id, report_channel_id, msg_log_channel_id, server_log_channel_id, min_account_age_days, warn_decay_days, muted_role_id, automod_enabled, captcha_enabled, verified_role_id, toxicity_enabled, toxicity_action, captcha_channel_id, log_profile_enabled, log_join_leave_enabled, log_voice_enabled, log_invite_enabled, log_roles_enabled, log_messages_enabled, welcome_channel_id, leave_channel_id, welcome_enabled, leave_enabled, welcome_message, leave_message, welcome_bg_url, leave_bg_url, welcome_accent_color, welcome_text_color, leave_accent_color, leave_text_color, voice_rec_enabled, voice_rec_channel_id, voice_rec_message, welcome_banner_enabled, leave_banner_enabled, welcome_banner_text, leave_banner_text FROM guilds WHERE guild_id = ?',
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

/**
 * Liefert die ID des globalen Captcha-Channels.
 */
async function getCaptchaChannelId(guildId) {
  const row = await readGuildRow(guildId);
  return row?.captcha_channel_id ? String(row.captcha_channel_id) : null;
}

/**
 * Setzt die ID des globalen Captcha-Channels.
 */
async function setCaptchaChannelId(guildId, channelId) {
  await getPool().execute(
    'UPDATE guilds SET captcha_channel_id = ? WHERE guild_id = ?',
    [channelId || null, guildId]
  );
}

/**
 * Liefert die server-log-channel-ID. Kein env-Fallback.
 */
async function getServerLogChannelId(guildId) {
  const row = await readGuildRow(guildId);
  return row?.server_log_channel_id ? String(row.server_log_channel_id) : null;
}

/**
 * Liefert ob das Profil-Logging aktiviert ist.
 */
async function isLogProfileEnabled(guildId) {
  const row = await readGuildRow(guildId);
  return Boolean(row?.log_profile_enabled);
}

/**
 * Liefert ob das Beitritts/Verlassens-Logging aktiviert ist.
 */
async function isLogJoinLeaveEnabled(guildId) {
  const row = await readGuildRow(guildId);
  return Boolean(row?.log_join_leave_enabled);
}

/**
 * Liefert ob das Voice-Logging aktiviert ist.
 */
async function isLogVoiceEnabled(guildId) {
  const row = await readGuildRow(guildId);
  return Boolean(row?.log_voice_enabled);
}

/**
 * Liefert ob das Einladungs-Logging aktiviert ist.
 */
async function isLogInviteEnabled(guildId) {
  const row = await readGuildRow(guildId);
  return Boolean(row?.log_invite_enabled);
}

/**
 * Liefert ob das Rollen-Logging aktiviert ist.
 */
async function isLogRolesEnabled(guildId) {
  const row = await readGuildRow(guildId);
  return Boolean(row?.log_roles_enabled);
}

/**
 * Liefert ob das Nachrichten-Logging aktiviert ist.
 */
async function isLogMessagesEnabled(guildId) {
  const row = await readGuildRow(guildId);
  return Boolean(row?.log_messages_enabled);
}

/**
 * Liefert die welcome-channel-ID.
 */
async function getWelcomeChannelId(guildId) {
  const row = await readGuildRow(guildId);
  return row?.welcome_channel_id ? String(row.welcome_channel_id) : null;
}

/**
 * Setzt die welcome-channel-ID.
 */
async function setWelcomeChannelId(guildId, channelId) {
  await getPool().execute(
    'UPDATE guilds SET welcome_channel_id = ? WHERE guild_id = ?',
    [channelId || null, guildId]
  );
}

/**
 * Liefert die leave-channel-ID.
 */
async function getLeaveChannelId(guildId) {
  const row = await readGuildRow(guildId);
  return row?.leave_channel_id ? String(row.leave_channel_id) : null;
}

/**
 * Setzt die leave-channel-ID.
 */
async function setLeaveChannelId(guildId, channelId) {
  await getPool().execute(
    'UPDATE guilds SET leave_channel_id = ? WHERE guild_id = ?',
    [channelId || null, guildId]
  );
}

/**
 * Liefert ob Welcome aktiviert ist.
 */
async function isWelcomeEnabled(guildId) {
  const row = await readGuildRow(guildId);
  return Boolean(row?.welcome_enabled);
}

/**
 * Setzt ob Welcome aktiviert ist.
 */
async function setWelcomeEnabled(guildId, enabled) {
  await getPool().execute(
    'UPDATE guilds SET welcome_enabled = ? WHERE guild_id = ?',
    [enabled ? 1 : 0, guildId]
  );
}

/**
 * Liefert ob Leave aktiviert ist.
 */
async function isLeaveEnabled(guildId) {
  const row = await readGuildRow(guildId);
  return Boolean(row?.leave_enabled);
}

/**
 * Setzt ob Leave aktiviert ist.
 */
async function setLeaveEnabled(guildId, enabled) {
  await getPool().execute(
    'UPDATE guilds SET leave_enabled = ? WHERE guild_id = ?',
    [enabled ? 1 : 0, guildId]
  );
}

/**
 * Liefert die Welcome-Nachricht.
 */
async function getWelcomeMessage(guildId) {
  const row = await readGuildRow(guildId);
  return row?.welcome_message ?? 'Willkommen {user} auf {server}!';
}

/**
 * Setzt die Welcome-Nachricht.
 */
async function setWelcomeMessage(guildId, message) {
  await getPool().execute(
    'UPDATE guilds SET welcome_message = ? WHERE guild_id = ?',
    [message || 'Willkommen {user} auf {server}!', guildId]
  );
}

/**
 * Liefert die Leave-Nachricht.
 */
async function getLeaveMessage(guildId) {
  const row = await readGuildRow(guildId);
  return row?.leave_message ?? '{user} hat den Server verlassen.';
}

/**
 * Setzt die Leave-Nachricht.
 */
async function setLeaveMessage(guildId, message) {
  await getPool().execute(
    'UPDATE guilds SET leave_message = ? WHERE guild_id = ?',
    [message || '{user} hat den Server verlassen.', guildId]
  );
}

/**
 * Liefert die Welcome-Hintergrund-URL.
 */
async function getWelcomeBgUrl(guildId) {
  const row = await readGuildRow(guildId);
  return row?.welcome_bg_url ?? null;
}

/**
 * Setzt die Welcome-Hintergrund-URL.
 */
async function setWelcomeBgUrl(guildId, url) {
  await getPool().execute(
    'UPDATE guilds SET welcome_bg_url = ? WHERE guild_id = ?',
    [url || null, guildId]
  );
}

/**
 * Liefert die Leave-Hintergrund-URL.
 */
async function getLeaveBgUrl(guildId) {
  const row = await readGuildRow(guildId);
  return row?.leave_bg_url ?? null;
}

/**
 * Setzt die Leave-Hintergrund-URL.
 */
async function setLeaveBgUrl(guildId, url) {
  await getPool().execute(
    'UPDATE guilds SET leave_bg_url = ? WHERE guild_id = ?',
    [url || null, guildId]
  );
}

/**
 * Liefert die Welcome-Akzentfarbe.
 */
async function getWelcomeAccentColor(guildId) {
  const row = await readGuildRow(guildId);
  return row?.welcome_accent_color ?? '#5865f2';
}

/**
 * Setzt die Welcome-Akzentfarbe.
 */
async function setWelcomeAccentColor(guildId, color) {
  await getPool().execute(
    'UPDATE guilds SET welcome_accent_color = ? WHERE guild_id = ?',
    [color || '#5865f2', guildId]
  );
}

/**
 * Liefert die Welcome-Textfarbe.
 */
async function getWelcomeTextColor(guildId) {
  const row = await readGuildRow(guildId);
  return row?.welcome_text_color ?? '#7289da';
}

/**
 * Setzt die Welcome-Textfarbe.
 */
async function setWelcomeTextColor(guildId, color) {
  await getPool().execute(
    'UPDATE guilds SET welcome_text_color = ? WHERE guild_id = ?',
    [color || '#7289da', guildId]
  );
}

/**
 * Liefert die Leave-Akzentfarbe.
 */
async function getLeaveAccentColor(guildId) {
  const row = await readGuildRow(guildId);
  return row?.leave_accent_color ?? '#e74c3c';
}

/**
 * Setzt die Leave-Akzentfarbe.
 */
async function setLeaveAccentColor(guildId, color) {
  await getPool().execute(
    'UPDATE guilds SET leave_accent_color = ? WHERE guild_id = ?',
    [color || '#e74c3c', guildId]
  );
}

/**
 * Liefert die Leave-Textfarbe.
 */
async function getLeaveTextColor(guildId) {
  const row = await readGuildRow(guildId);
  return row?.leave_text_color ?? '#e74c3c';
}

/**
 * Setzt die Leave-Textfarbe.
 */
async function setLeaveTextColor(guildId, color) {
  await getPool().execute(
    'UPDATE guilds SET leave_text_color = ? WHERE guild_id = ?',
    [color || '#e74c3c', guildId]
  );
}

/**
 * Liefert ob das Welcome-Banner aktiviert ist (Default: true/1).
 */
async function isWelcomeBannerEnabled(guildId) {
  const row = await readGuildRow(guildId);
  return row?.welcome_banner_enabled !== 0;
}

/**
 * Setzt ob das Welcome-Banner aktiviert ist.
 */
async function setWelcomeBannerEnabled(guildId, enabled) {
  await getPool().execute(
    'UPDATE guilds SET welcome_banner_enabled = ? WHERE guild_id = ?',
    [enabled ? 1 : 0, guildId]
  );
}

/**
 * Liefert ob das Leave-Banner aktiviert ist (Default: true/1).
 */
async function isLeaveBannerEnabled(guildId) {
  const row = await readGuildRow(guildId);
  return row?.leave_banner_enabled !== 0;
}

/**
 * Setzt ob das Leave-Banner aktiviert ist.
 */
async function setLeaveBannerEnabled(guildId, enabled) {
  await getPool().execute(
    'UPDATE guilds SET leave_banner_enabled = ? WHERE guild_id = ?',
    [enabled ? 1 : 0, guildId]
  );
}

/**
 * Liefert den Welcome-Banner-Text.
 */
async function getWelcomeBannerText(guildId) {
  const row = await readGuildRow(guildId);
  return row?.welcome_banner_text ?? 'WILLKOMMEN';
}

/**
 * Setzt den Welcome-Banner-Text.
 */
async function setWelcomeBannerText(guildId, text) {
  await getPool().execute(
    'UPDATE guilds SET welcome_banner_text = ? WHERE guild_id = ?',
    [text || 'WILLKOMMEN', guildId]
  );
}

/**
 * Liefert den Leave-Banner-Text.
 */
async function getLeaveBannerText(guildId) {
  const row = await readGuildRow(guildId);
  return row?.leave_banner_text ?? 'AUF WIEDERSEHEN';
}

/**
 * Setzt den Leave-Banner-Text.
 */
async function setLeaveBannerText(guildId, text) {
  await getPool().execute(
    'UPDATE guilds SET leave_banner_text = ? WHERE guild_id = ?',
    [text || 'AUF WIEDERSEHEN', guildId]
  );
}

/**
 * Liefert ob Voice Recognition aktiviert ist.
 */
async function getVoiceRecEnabled(guildId) {
  const row = await readGuildRow(guildId);
  return Boolean(row?.voice_rec_enabled);
}

/**
 * Setzt ob Voice Recognition aktiviert ist.
 */
async function setVoiceRecEnabled(guildId, enabled) {
  await getPool().execute(
    'UPDATE guilds SET voice_rec_enabled = ? WHERE guild_id = ?',
    [enabled ? 1 : 0, guildId]
  );
}

/**
 * Liefert die voice-rec-channel-ID.
 */
async function getVoiceRecChannelId(guildId) {
  const row = await readGuildRow(guildId);
  return row?.voice_rec_channel_id ? String(row.voice_rec_channel_id) : null;
}

/**
 * Setzt die voice-rec-channel-ID.
 */
async function setVoiceRecChannelId(guildId, channelId) {
  await getPool().execute(
    'UPDATE guilds SET voice_rec_channel_id = ? WHERE guild_id = ?',
    [channelId || null, guildId]
  );
}

/**
 * Liefert die Voice-Rec-Nachricht.
 */
async function getVoiceRecMessage(guildId) {
  const row = await readGuildRow(guildId);
  return row?.voice_rec_message ?? 'Wer hat Oreo Ban gerufen? Ab ins Gefängnis!';
}

/**
 * Setzt die Voice-Rec-Nachricht.
 */
async function setVoiceRecMessage(guildId, message) {
  await getPool().execute(
    'UPDATE guilds SET voice_rec_message = ? WHERE guild_id = ?',
    [message || 'Wer hat Oreo Ban gerufen? Ab ins Gefängnis!', guildId]
  );
}

module.exports = {
  getModLogChannelId,
  getReportChannelId,
  getMsgLogChannelId,
  getServerLogChannelId,
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
  getCaptchaChannelId,
  setCaptchaChannelId,
  isLogProfileEnabled,
  isLogJoinLeaveEnabled,
  isLogVoiceEnabled,
  isLogInviteEnabled,
  isLogRolesEnabled,
  isLogMessagesEnabled,
  getWelcomeChannelId,
  setWelcomeChannelId,
  getLeaveChannelId,
  setLeaveChannelId,
  isWelcomeEnabled,
  setWelcomeEnabled,
  isLeaveEnabled,
  setLeaveEnabled,
  getWelcomeMessage,
  setWelcomeMessage,
  getLeaveMessage,
  setLeaveMessage,
  getWelcomeBgUrl,
  setWelcomeBgUrl,
  getLeaveBgUrl,
  setLeaveBgUrl,
  getWelcomeAccentColor,
  setWelcomeAccentColor,
  getWelcomeTextColor,
  setWelcomeTextColor,
  getLeaveAccentColor,
  setLeaveAccentColor,
  getLeaveTextColor,
  setLeaveTextColor,
  getVoiceRecEnabled,
  setVoiceRecEnabled,
  getVoiceRecChannelId,
  setVoiceRecChannelId,
  getVoiceRecMessage,
  setVoiceRecMessage,
  isWelcomeBannerEnabled,
  setWelcomeBannerEnabled,
  isLeaveBannerEnabled,
  setLeaveBannerEnabled,
  getWelcomeBannerText,
  setWelcomeBannerText,
  getLeaveBannerText,
  setLeaveBannerText,
};

