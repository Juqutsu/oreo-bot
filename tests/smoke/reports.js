// Run with: node tests/smoke/reports.js
const reports = require('../../src/reports');
const { getPool } = require('../../src/db');
const assert = require('node:assert/strict');

const GUILD = '999999999999999000';
const REPORTER = '999999999999999001';
const TARGET = '999999999999999002';
const MOD = '999999999999999003';

async function main() {
  const pool = getPool();

  // Ensure parent guild row exists (FK constraint on reports.guild_id → guilds.guild_id)
  // no-op upsert: ensures the guild row exists (FK target) without failing if it already does
  await pool.query(
    `INSERT INTO guilds (guild_id, next_case_number)
       VALUES (?, 1) ON DUPLICATE KEY UPDATE guild_id = guild_id`,
    [GUILD],
  );

  // Cleanup any old test rows
  await pool.query(`DELETE FROM reports WHERE guild_id = ?`, [GUILD]);

  // --- createReport ---
  const reportId = await reports.createReport({
    guildId: GUILD,
    reporterId: REPORTER,
    reportedUserId: TARGET,
    reason: 'Test report from smoke',
    evidenceUrl: 'https://example.com/proof',
  });
  assert.ok(reportId > 0, 'createReport returns a positive id');

  // --- getReport ---
  const row = await reports.getReport(reportId);
  assert.equal(row.status, 'open', 'fresh report is open');
  assert.equal(row.reporter_id.toString(), REPORTER, 'reporter_id roundtrip');
  assert.equal(row.evidence_url, 'https://example.com/proof', 'evidence_url roundtrip');
  assert.equal(row.message_id, null, 'message_id starts NULL');

  // --- attachMessageId ---
  await reports.attachMessageId(reportId, '888888888888888001');
  const row2 = await reports.getReport(reportId);
  assert.equal(row2.message_id.toString(), '888888888888888001', 'message_id roundtrip');

  // --- hasOpenReportFromTo ---
  assert.equal(await reports.hasOpenReportFromTo(GUILD, REPORTER, TARGET), true, 'dup-check sees open report');
  assert.equal(await reports.hasOpenReportFromTo(GUILD, REPORTER, '999999999999999099'), false, 'dup-check misses unrelated target');

  // --- claimReport ---
  await reports.claimReport(reportId, MOD);
  const row3 = await reports.getReport(reportId);
  assert.equal(row3.status, 'investigating', 'claim → investigating');
  assert.equal(row3.assigned_mod_id.toString(), MOD, 'assigned_mod_id set');

  // --- resolveReport with caseNumber ---
  await reports.resolveReport(reportId, { modId: MOD, note: 'spam — warned', caseNumber: 42 });
  const row4 = await reports.getReport(reportId);
  assert.equal(row4.status, 'resolved', 'resolve → resolved');
  assert.equal(row4.resolution_case_number, 42, 'caseNumber linked');
  assert.equal(row4.resolution_note, 'spam — warned', 'note saved');
  assert.ok(row4.resolved_at !== null, 'resolved_at set');

  // --- Second report: None-path ---
  const reportId2 = await reports.createReport({
    guildId: GUILD,
    reporterId: REPORTER,
    reportedUserId: '999999999999999004',
    reason: 'Second test',
    evidenceUrl: null,
  });
  await reports.resolveReport(reportId2, { modId: MOD, note: null, caseNumber: null });
  const row5 = await reports.getReport(reportId2);
  assert.equal(row5.status, 'resolved', 'None-path also resolved');
  assert.equal(row5.resolution_case_number, null, 'None-path leaves caseNumber NULL');

  // --- dismissReport ---
  const reportId3 = await reports.createReport({
    guildId: GUILD,
    reporterId: REPORTER,
    reportedUserId: '999999999999999005',
    reason: 'Third test',
    evidenceUrl: null,
  });
  await reports.dismissReport(reportId3, { modId: MOD, note: 'duplicate' });
  const row6 = await reports.getReport(reportId3);
  assert.equal(row6.status, 'dismissed', 'dismiss → dismissed');
  assert.equal(row6.resolution_note, 'duplicate', 'dismiss-note saved');

  // --- Cooldown ---
  assert.equal(reports.checkCooldown(REPORTER), 0, 'cooldown initially 0');
  reports.touchCooldown(REPORTER);
  const r1 = reports.checkCooldown(REPORTER);
  assert.ok(r1 > 0 && r1 <= reports.COOLDOWN_MS, 'cooldown active and within window');
  await new Promise(r => setTimeout(r, 200)); // robust enough on a loaded CI box
  const r2 = reports.checkCooldown(REPORTER);
  assert.ok(r2 < r1, 'cooldown ticks down');

  // Cleanup
  await pool.query(`DELETE FROM reports WHERE guild_id = ?`, [GUILD]);
  await pool.query(`DELETE FROM guilds WHERE guild_id = ?`, [GUILD]);

  await pool.end();
  console.log('OK — reports smoke test passed');
}

main().catch(e => { console.error(e); process.exit(1); });
