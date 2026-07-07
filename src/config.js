const { getPool } = require('./db');
const { normalize } = require('./obfuscation');

// TTL-Cache für die Guild-Config-Row (`guilds`-Tabelle). Vermeidet die 15+ identischen
// SELECTs pro Join / 3 pro Nachricht, die entstehen weil jeder Getter readGuildRow aufruft.
const ROW_CACHE_TTL_MS = 30_000;
// guildId -> { row, fetchedAt }
const rowCache = new Map();

// TTL-Cache für Bad Words (+ vor-normalisierte Varianten) pro Guild.
const BAD_WORDS_CACHE_TTL_MS = 30_000;
// guildId -> { words, normalized, fetchedAt }
const badWordsCache = new Map();

/**
 * Invalidiert die gecachte Guild-Row. Wird von JEDEM Setter direkt nach seinem
 * UPDATE aufgerufen, damit der nächste Read wieder frische Daten aus der DB liest.
 * @param {string} guildId
 */
function invalidateGuildRowCache(guildId) {
  rowCache.delete(guildId);
}

/**
 * Invalidiert den gecachten Bad-Words-Eintrag einer Guild.
 * @param {string} guildId
 */
function invalidateBadWordsCache(guildId) {
  badWordsCache.delete(guildId);
}

/**
 * Liest die Config-Row einer Guild aus `guilds`. Gecacht für ROW_CACHE_TTL_MS.
 * @param {string} guildId
 * @returns {Promise<{mod_log_channel_id: string|null, report_channel_id: string|null, automod_enabled: number}|null>}
 */
async function readGuildRow(guildId) {
  const cached = rowCache.get(guildId);
  if (cached && Date.now() - cached.fetchedAt < ROW_CACHE_TTL_MS) {
    return cached.row;
  }

  const [rows] = await getPool().execute(
    'SELECT mod_log_channel_id, report_channel_id, msg_log_channel_id, server_log_channel_id, min_account_age_days, warn_decay_days, muted_role_id, automod_enabled, captcha_enabled, verified_role_id, join_role_id, join_role_ids, verified_role_ids, unverified_role_ids, toxicity_enabled, toxicity_action, captcha_channel_id, log_profile_enabled, log_join_leave_enabled, log_voice_enabled, log_invite_enabled, log_roles_enabled, log_messages_enabled, welcome_channel_id, leave_channel_id, welcome_enabled, leave_enabled, welcome_message, leave_message, welcome_bg_url, leave_bg_url, welcome_accent_color, welcome_text_color, leave_accent_color, leave_text_color, voice_rec_enabled, voice_rec_channel_id, voice_rec_message, welcome_banner_enabled, leave_banner_enabled, welcome_banner_text, leave_banner_text FROM guilds WHERE guild_id = ?',
    [guildId],
  );
  const row = rows[0] ?? null;
  rowCache.set(guildId, { row, fetchedAt: Date.now() });
  return row;
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
}

// Helper for parsing comma-separated list
function parseRolesList(str) {
  if (!str) return [];
  return str.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Liefert die Liste aller Join-Rollen (mit Fallback auf getJoinRoleId).
 */
async function getJoinRoleIds(guildId) {
  const row = await readGuildRow(guildId);
  const list = parseRolesList(row?.join_role_ids);
  if (list.length > 0) return list;
  // Fallback to single old role if configured
  return row?.join_role_id ? [String(row.join_role_id)] : [];
}

/**
 * Fügt eine Join-Rolle zur Liste hinzu.
 */
async function addJoinRoleId(guildId, roleId) {
  const current = await getJoinRoleIds(guildId);
  if (current.includes(roleId)) return false;
  current.push(roleId);
  await getPool().execute(
    'UPDATE guilds SET join_role_ids = ? WHERE guild_id = ?',
    [current.join(','), guildId]
  );
  invalidateGuildRowCache(guildId);
  return true;
}

/**
 * Entfernt eine Join-Rolle aus der Liste.
 */
async function removeJoinRoleId(guildId, roleId) {
  const current = await getJoinRoleIds(guildId);
  if (!current.includes(roleId)) return false;
  const next = current.filter(id => id !== roleId);
  await getPool().execute(
    'UPDATE guilds SET join_role_ids = ? WHERE guild_id = ?',
    [next.length > 0 ? next.join(',') : null, guildId]
  );
  invalidateGuildRowCache(guildId);
  return true;
}

/**
 * Liefert die Liste aller verifizierten Rollen (mit Fallback auf getVerifiedRoleId).
 */
async function getVerifiedRoleIds(guildId) {
  const row = await readGuildRow(guildId);
  const list = parseRolesList(row?.verified_role_ids);
  if (list.length > 0) return list;
  // Fallback to single old role if configured
  return row?.verified_role_id ? [String(row.verified_role_id)] : [];
}

/**
 * Fügt eine verifizierte Rolle hinzu.
 */
async function addVerifiedRoleId(guildId, roleId) {
  const current = await getVerifiedRoleIds(guildId);
  if (current.includes(roleId)) return false;
  current.push(roleId);
  await getPool().execute(
    'UPDATE guilds SET verified_role_ids = ? WHERE guild_id = ?',
    [current.join(','), guildId]
  );
  invalidateGuildRowCache(guildId);
  return true;
}

/**
 * Entfernt eine verifizierte Rolle.
 */
async function removeVerifiedRoleId(guildId, roleId) {
  const current = await getVerifiedRoleIds(guildId);
  if (!current.includes(roleId)) return false;
  const next = current.filter(id => id !== roleId);
  await getPool().execute(
    'UPDATE guilds SET verified_role_ids = ? WHERE guild_id = ?',
    [next.length > 0 ? next.join(',') : null, guildId]
  );
  invalidateGuildRowCache(guildId);
  return true;
}

/**
 * Liefert die Liste aller unverified Rollen (Rollen, die bei Verifizierung entfernt werden).
 */
async function getUnverifiedRoleIds(guildId) {
  const row = await readGuildRow(guildId);
  return parseRolesList(row?.unverified_role_ids);
}

/**
 * Fügt eine unverified Rolle hinzu.
 */
async function addUnverifiedRoleId(guildId, roleId) {
  const current = await getUnverifiedRoleIds(guildId);
  if (current.includes(roleId)) return false;
  current.push(roleId);
  await getPool().execute(
    'UPDATE guilds SET unverified_role_ids = ? WHERE guild_id = ?',
    [current.join(','), guildId]
  );
  invalidateGuildRowCache(guildId);
  return true;
}

/**
 * Entfernt eine unverified Rolle.
 */
async function removeUnverifiedRoleId(guildId, roleId) {
  const current = await getUnverifiedRoleIds(guildId);
  if (!current.includes(roleId)) return false;
  const next = current.filter(id => id !== roleId);
  await getPool().execute(
    'UPDATE guilds SET unverified_role_ids = ? WHERE guild_id = ?',
    [next.length > 0 ? next.join(',') : null, guildId]
  );
  invalidateGuildRowCache(guildId);
  return true;
}

/**
 * Liefert die Join-Rolle (Auto-Role). Deprecated.
 */
async function getJoinRoleId(guildId) {
  const row = await readGuildRow(guildId);
  return row?.join_role_id ? String(row.join_role_id) : null;
}

/**
 * Setzt die Join-Rolle (Auto-Role). Deprecated.
 */
async function setJoinRoleId(guildId, roleId) {
  await getPool().execute(
    'UPDATE guilds SET join_role_id = ? WHERE guild_id = ?',
    [roleId || null, guildId]
  );
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
}

/**
 * Liefert die Liste aller Bad Words einer Guild. Gecacht für BAD_WORDS_CACHE_TTL_MS.
 */
async function getBadWords(guildId) {
  const cached = badWordsCache.get(guildId);
  if (cached && Date.now() - cached.fetchedAt < BAD_WORDS_CACHE_TTL_MS) {
    return cached.words;
  }

  const [rows] = await getPool().execute(
    'SELECT word FROM bad_words WHERE guild_id = ? ORDER BY word ASC',
    [guildId]
  );
  const words = rows.map((r) => r.word);
  const normalized = words.map((word) => ({ word, normalized: normalize(word) }));
  badWordsCache.set(guildId, { words, normalized, fetchedAt: Date.now() });
  return words;
}

/**
 * Liefert die Bad Words einer Guild vor-normalisiert (einmal pro Cache-Füllung berechnet),
 * damit der Toxizitätsfilter nicht bei jeder Nachricht jedes Wort erneut normalisieren muss.
 * @param {string} guildId
 * @returns {Promise<{word: string, normalized: string}[]>}
 */
async function getNormalizedBadWords(guildId) {
  const cached = badWordsCache.get(guildId);
  if (cached && Date.now() - cached.fetchedAt < BAD_WORDS_CACHE_TTL_MS) {
    return cached.normalized;
  }
  await getBadWords(guildId); // füllt den Cache (inkl. normalized) über den gemeinsamen Code-Pfad
  return badWordsCache.get(guildId)?.normalized ?? [];
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
  invalidateBadWordsCache(guildId);
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
  invalidateBadWordsCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  invalidateGuildRowCache(guildId);
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
  getNormalizedBadWords,
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
  getJoinRoleId,
  setJoinRoleId,
  getJoinRoleIds,
  addJoinRoleId,
  removeJoinRoleId,
  getVerifiedRoleIds,
  addVerifiedRoleId,
  removeVerifiedRoleId,
  getUnverifiedRoleIds,
  addUnverifiedRoleId,
  removeUnverifiedRoleId,
};
