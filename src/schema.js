const fs = require('node:fs');
const path = require('node:path');
const { getPool } = require('./db');

const SCHEMA_FILE = path.join(__dirname, '..', 'server', 'schema.sql');

async function ensureSchema() {
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');

  // Statements am Semikolon-Ende-of-Line trennen.
  // In jedem Statement: -- Kommentarzeilen entfernen, trimmen.
  // Leere Statements verwerfen.
  const statements = sql
    .split(/;\s*$/m)
    .map((stmt) =>
      stmt
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter((stmt) => stmt.length > 0);

  const pool = getPool();
  for (const stmt of statements) {
    try {
      await pool.query(stmt);
    } catch (err) {
      // 1060 = ER_DUP_FIELDNAME: column already exists — idempotent ADD COLUMN
      if (err.errno === 1060) {
        console.warn('[schema] Skipped duplicate column (errno 1060):', err.sqlMessage);
        continue;
      }
      // 1061 = ER_DUP_KEYNAME: index already exists — idempotent ADD INDEX
      if (err.errno === 1061) {
        console.warn('[schema] Skipped duplicate index (errno 1061):', err.sqlMessage);
        continue;
      }
      // 1091 = ER_CANT_DROP_FIELD_OR_KEY: key doesn't exist — idempotent DROP INDEX
      if (err.errno === 1091) {
        console.warn('[schema] Skipped dropping missing key (errno 1091):', err.sqlMessage);
        continue;
      }
      throw err;
    }
  }
}

module.exports = { ensureSchema };
