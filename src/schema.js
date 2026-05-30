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
      if (err.errno === 1060) continue;
      throw err;
    }
  }
}

module.exports = { ensureSchema };
