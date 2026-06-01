const { getPool } = require('./db');

const COOLDOWN_MS = 60_000;
const cooldown = new Map(); // userId (string) → epoch ms

async function createReport({ guildId, reporterId, reportedUserId, reason, evidenceUrl }) {
  const pool = getPool();
  const [result] = await pool.query(
    `INSERT INTO reports (guild_id, reporter_id, reported_user_id, reason, evidence_url, status)
     VALUES (?, ?, ?, ?, ?, 'open')`,
    [guildId, reporterId, reportedUserId, reason, evidenceUrl ?? null],
  );
  return result.insertId;
}

async function attachMessageId(reportId, messageId) {
  const pool = getPool();
  await pool.query(`UPDATE reports SET message_id = ? WHERE id = ?`, [messageId, reportId]);
}

async function getReport(reportId, { forUpdate = false, conn = null } = {}) {
  const runner = conn ?? getPool();
  const sql = `SELECT * FROM reports WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`;
  const [rows] = await runner.query(sql, [reportId]);
  return rows[0] ?? null;
}

async function hasOpenReportFromTo(guildId, reporterId, reportedUserId) {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT 1 FROM reports
      WHERE guild_id = ? AND reporter_id = ? AND reported_user_id = ?
        AND status IN ('open','investigating')
      LIMIT 1`,
    [guildId, reporterId, reportedUserId],
  );
  return rows.length > 0;
}

async function claimReport(reportId, modId, { conn = null } = {}) {
  const runner = conn ?? getPool();
  await runner.query(
    `UPDATE reports SET status = 'investigating', assigned_mod_id = ? WHERE id = ?`,
    [modId, reportId],
  );
}

async function resolveReport(reportId, { modId, note, caseNumber, conn = null }) {
  const runner = conn ?? getPool();
  await runner.query(
    `UPDATE reports
       SET status = 'resolved',
           assigned_mod_id = ?,
           resolved_at = NOW(),
           resolution_note = ?,
           resolution_case_number = ?
     WHERE id = ?`,
    [modId, note ?? null, caseNumber ?? null, reportId],
  );
}

async function dismissReport(reportId, { modId, note, conn = null }) {
  const runner = conn ?? getPool();
  await runner.query(
    `UPDATE reports
       SET status = 'dismissed',
           assigned_mod_id = ?,
           resolved_at = NOW(),
           resolution_note = ?
     WHERE id = ?`,
    [modId, note ?? null, reportId],
  );
}

function checkCooldown(userId) {
  const last = cooldown.get(userId);
  if (!last) return 0;
  const remaining = COOLDOWN_MS - (Date.now() - last);
  return remaining > 0 ? remaining : 0;
}

function touchCooldown(userId) {
  cooldown.set(userId, Date.now());
}

module.exports = {
  createReport,
  attachMessageId,
  getReport,
  hasOpenReportFromTo,
  claimReport,
  resolveReport,
  dismissReport,
  checkCooldown,
  touchCooldown,
  COOLDOWN_MS,
};
