const { getPool } = require('./db');

/** Persists a posted announcement. Returns the new row id. */
async function createAnnouncement({ guildId, channelId, messageId, authorId, title, description, color = null, imageUrl = null, pingRoleId = null }) {
  const [result] = await getPool().execute(
    `INSERT INTO announcements (guild_id, channel_id, message_id, author_id, title, description, color, image_url, ping_role_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [guildId, channelId, messageId, authorId, title, description, color, imageUrl, pingRoleId],
  );
  return result.insertId;
}

/** Returns the row (any status, so orphan cleanup can find deleted ones) or null. */
async function getAnnouncement(guildId, id) {
  const [rows] = await getPool().execute(
    'SELECT * FROM announcements WHERE guild_id = ? AND id = ?',
    [guildId, id],
  );
  return rows[0] ?? null;
}

/**
 * Latest posted announcements, newest first.
 * Note: LIMIT ? behaves inconsistently with mysql2's execute() (prepared
 * statements) across server versions, so — matching listWarnings/
 * listUserInfractions in src/cases.js — this uses query() with a
 * Number()-cast limit (injection-safe: NaN/negative collapse to the default).
 */
async function listRecent(guildId, limit = 25) {
  const safeLimit = Number(limit) || 25;
  const [rows] = await getPool().query(
    `SELECT * FROM announcements WHERE guild_id = ? AND status = 'posted' ORDER BY id DESC LIMIT ?`,
    [guildId, safeLimit],
  );
  return rows;
}

async function updateAnnouncement(guildId, id, { title, description, imageUrl, editedBy }) {
  await getPool().execute(
    `UPDATE announcements SET title = ?, description = ?, image_url = ?, edited_at = NOW(), edited_by = ?
     WHERE guild_id = ? AND id = ?`,
    [title, description, imageUrl ?? null, editedBy, guildId, id],
  );
}

async function markDeleted(guildId, id) {
  await getPool().execute(
    `UPDATE announcements SET status = 'deleted' WHERE guild_id = ? AND id = ?`,
    [guildId, id],
  );
}

module.exports = { createAnnouncement, getAnnouncement, listRecent, updateAnnouncement, markDeleted };
