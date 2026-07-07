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
  expiresInMs = null,
  source = 'manual',
  active = 1,
}) {
  // Defensive truncation — reason column is VARCHAR(512); callers already cap
  // the slash-command option at 512 chars, but this guards non-command callers too.
  reason = reason != null ? String(reason).slice(0, 512) : null;

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
    // expires_at wird bevorzugt DB-seitig aus expiresInMs (Sekunden relativ zu NOW()) berechnet,
    // damit mysql2 keinen JS-Date-Wert in Node-lokaler Zeit serialisiert (sonst Timezone-Skew
    // gegenüber background.js, das mit MySQL NOW() vergleicht). Legacy expiresAt (JS Date)
    // bleibt zur Rückwärtskompatibilität unterstützt, wenn expiresInMs nicht gesetzt ist.
    const expiresSql = expiresInMs != null ? 'DATE_ADD(NOW(), INTERVAL ? SECOND)' : '?';
    const expiresParam = expiresInMs != null ? Math.round(Number(expiresInMs) / 1000) : expiresAt;

    const [result] = await conn.execute(
      `INSERT INTO infractions
         (guild_id, case_number, user_id, moderator_id, type, source, reason, duration_ms, expires_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${expiresSql}, ?)`,
      [guildId, caseNumber, userId, moderatorId, type, source, reason, durationMs, expiresParam, active],
    );

    // 5. Cross-Bot economy penalty (Ramen & Oreo synergy)
    let penalty = 0;
    if (type === 'warn') {
      penalty = 250;
    } else if (type === 'timeout' || type === 'mute') {
      penalty = 500;
    } else if (type === 'kick' || type === 'ban' || type === 'softban') {
      penalty = 1000;
    }

    if (penalty > 0) {
      await conn.execute(
        `UPDATE guild_users 
         SET currency = IF(currency >= ?, currency - ?, 0) 
         WHERE guild_id = ? AND user_id = ?`,
        [penalty, penalty, guildId, userId]
      );
      console.log(`[synergy] Deducted ${penalty} Ramen coins from user ${userId} on guild ${guildId} due to infraction: ${type}`);
    }

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
       LIMIT ?`,
    [guildId, userId, Number(limit)],
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

/**
 * Soft-Delete einer Warnung. Setzt active=0 + erstellt Meta-Case (type='warn_removed').
 * Transaktional mit SELECT ... FOR UPDATE Lock.
 * @returns {Promise<{metaCaseNumber: number}|null>}
 *   null wenn: Original existiert nicht, ist kein Warn, oder ist bereits active=0
 */
async function removeWarn({ guildId, originalCaseNumber, moderatorId, reason = null }) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();

    const [origRows] = await conn.execute(
      'SELECT id, user_id, type, active FROM infractions WHERE guild_id = ? AND case_number = ? FOR UPDATE',
      [guildId, originalCaseNumber],
    );
    const original = origRows[0];
    if (!original || original.type !== 'warn' || !original.active) {
      await conn.rollback();
      return null;
    }

    await conn.execute('UPDATE infractions SET active = 0 WHERE id = ?', [original.id]);

    await conn.execute(
      'UPDATE guilds SET next_case_number = LAST_INSERT_ID(next_case_number + 1) WHERE guild_id = ?',
      [guildId],
    );
    const [[row]] = await conn.query('SELECT LAST_INSERT_ID() AS metaCaseNumber');
    const metaCaseNumber = row.metaCaseNumber;

    await conn.execute(
      `INSERT INTO infractions (guild_id, case_number, parent_case_number, user_id, moderator_id, type, source, reason)
       VALUES (?, ?, ?, ?, ?, 'warn_removed', 'manual', ?)`,
      [guildId, metaCaseNumber, originalCaseNumber, original.user_id, moderatorId, reason],
    );

    await conn.commit();
    return { metaCaseNumber };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Editiert den Reason eines bestehenden Cases. Überschreibt + erstellt Meta-Case (type='reason_edited').
 * Repository-Funktion ist typ-agnostisch — Meta-Case-Schutz liegt im /reason-Command.
 * @returns {Promise<{metaCaseNumber: number, oldReason: string|null}|null>}
 *   null wenn Original-Case nicht existiert
 */
async function editReason({ guildId, originalCaseNumber, moderatorId, newReason }) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();

    const [origRows] = await conn.execute(
      'SELECT id, user_id, reason FROM infractions WHERE guild_id = ? AND case_number = ? FOR UPDATE',
      [guildId, originalCaseNumber],
    );
    const original = origRows[0];
    if (!original) {
      await conn.rollback();
      return null;
    }
    const oldReason = original.reason;

    await conn.execute('UPDATE infractions SET reason = ? WHERE id = ?', [newReason, original.id]);

    await conn.execute(
      'UPDATE guilds SET next_case_number = LAST_INSERT_ID(next_case_number + 1) WHERE guild_id = ?',
      [guildId],
    );
    const [[row]] = await conn.query('SELECT LAST_INSERT_ID() AS metaCaseNumber');
    const metaCaseNumber = row.metaCaseNumber;

    let diffReason = `Alt: ${oldReason ?? '(leer)'} → Neu: ${newReason ?? '(leer)'}`;
    // reason column is VARCHAR(512) — the diff can exceed that (e.g. two long reasons), truncate before INSERT.
    diffReason = diffReason.length > 512 ? diffReason.slice(0, 509) + '…' : diffReason;
    await conn.execute(
      `INSERT INTO infractions (guild_id, case_number, parent_case_number, user_id, moderator_id, type, source, reason)
       VALUES (?, ?, ?, ?, ?, 'reason_edited', 'manual', ?)`,
      [guildId, metaCaseNumber, originalCaseNumber, original.user_id, moderatorId, diffReason],
    );

    await conn.commit();
    return { metaCaseNumber, oldReason };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Listet ALLE Infractions eines Users (alle Typen außer Meta-Cases).
 * Für /modhistory.
 * @returns {Promise<object[]>}
 */
async function listUserInfractions(guildId, userId, { includeInactive = true, limit = 25 } = {}) {
  const activeFilter = includeInactive ? '' : 'AND active = 1';
  const [rows] = await getPool().query(
    `SELECT * FROM infractions
       WHERE guild_id = ? AND user_id = ?
         AND type NOT IN ('warn_removed', 'reason_edited')
         ${activeFilter}
       ORDER BY created_at DESC
       LIMIT ?`,
    [guildId, userId, Number(limit)],
  );
  return rows;
}

/**
 * Deaktiviert alle aktiven Infractions eines bestimmten Typs für einen User.
 * @returns {Promise<void>}
 */
async function deactivateActiveInfractions(guildId, userId, type) {
  await getPool().execute(
    'UPDATE infractions SET active = 0 WHERE guild_id = ? AND user_id = ? AND type = ? AND active = 1',
    [guildId, userId, type]
  );
}

module.exports = {
  createCase,
  getCaseByNumber,
  listWarnings,
  listUserInfractions,
  countActiveWarnings,
  deactivate,
  deactivateActiveInfractions,
  removeWarn,
  editReason,
};
