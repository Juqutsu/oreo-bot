const { getPool } = require('./db');

/**
 * Erstellt einen neuen Case (= Eintrag in `infractions`).
 * Vergibt atomar die nächste case_number für den Server.
 *
 * @returns {Promise<{caseNumber: number, infractionId: number}>}
 */
async function createCase({
  guildId,
  userId,
  moderatorId,
  type,
  reason = null,
  durationMs = null,
  expiresAt = null,
  source = 'manual',
}) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();

    // 1. Guild-Row sicherstellen (no-op wenn schon da).
    await conn.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [guildId]);

    // 2. Counter atomar inkrementieren; neuer Wert landet in LAST_INSERT_ID.
    await conn.execute(
      'UPDATE guilds SET next_case_number = LAST_INSERT_ID(next_case_number + 1) WHERE guild_id = ?',
      [guildId],
    );

    // 3. Neuen case_number auslesen.
    const [[row]] = await conn.query('SELECT LAST_INSERT_ID() AS caseNumber');
    const caseNumber = row.caseNumber;

    // 4. Infraction speichern.
    const [result] = await conn.execute(
      `INSERT INTO infractions
         (guild_id, case_number, user_id, moderator_id, type, source, reason, duration_ms, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [guildId, caseNumber, userId, moderatorId, type, source, reason, durationMs, expiresAt],
    );

    await conn.commit();
    return { caseNumber, infractionId: result.insertId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Lädt einen Case anhand seiner Nummer (pro Guild eindeutig).
 * @returns {Promise<object|null>}
 */
async function getCaseByNumber(guildId, caseNumber) {
  const [rows] = await getPool().execute(
    'SELECT * FROM infractions WHERE guild_id = ? AND case_number = ?',
    [guildId, caseNumber],
  );
  return rows[0] ?? null;
}

/**
 * Listet Warnungen eines Users.
 * @returns {Promise<object[]>}
 */
async function listWarnings(guildId, userId, { includeInactive = false, limit = 25 } = {}) {
  const activeFilter = includeInactive ? '' : 'AND active = 1';
  const [rows] = await getPool().query(
    `SELECT * FROM infractions
       WHERE guild_id = ? AND user_id = ? AND type = 'warn' ${activeFilter}
       ORDER BY created_at DESC
       LIMIT ${Number(limit)}`,
    [guildId, userId],
  );
  return rows;
}

/**
 * Zählt aktive Warnungen eines Users.
 * @returns {Promise<number>}
 */
async function countActiveWarnings(guildId, userId) {
  const [[row]] = await getPool().execute(
    `SELECT COUNT(*) AS n FROM infractions
       WHERE guild_id = ? AND user_id = ? AND type = 'warn' AND active = 1`,
    [guildId, userId],
  );
  return Number(row.n);
}

/**
 * Setzt eine Infraction auf inactive (für späteres /removewarn).
 * @returns {Promise<boolean>} true wenn ein Row geändert wurde.
 */
async function deactivate(guildId, caseNumber) {
  const [result] = await getPool().execute(
    'UPDATE infractions SET active = 0 WHERE guild_id = ? AND case_number = ?',
    [guildId, caseNumber],
  );
  return result.affectedRows > 0;
}

module.exports = {
  createCase,
  getCaseByNumber,
  listWarnings,
  countActiveWarnings,
  deactivate,
};
