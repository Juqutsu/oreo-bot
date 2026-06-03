// Run with: node --env-file=.env tests/smoke/escalations.js
const escalations = require('../../src/escalations');
const { getPool } = require('../../src/db');
const assert = require('node:assert/strict');

const GUILD = '888888888888888100';

async function main() {
  const pool = getPool();

  // Ensure parent guild row exists (FK constraint)
  await pool.query(
    `INSERT INTO guilds (guild_id, next_case_number)
       VALUES (?, 1) ON DUPLICATE KEY UPDATE guild_id = guild_id`,
    [GUILD],
  );

  // Cleanup any old test rows
  await pool.query(`DELETE FROM escalation_rules WHERE guild_id = ?`, [GUILD]);

  // --- setRule + getRuleForThreshold roundtrip ---
  await escalations.setRule(GUILD, 3, 'timeout', 30);
  const rule3 = await escalations.getRuleForThreshold(GUILD, 3);
  assert.ok(rule3, 'rule for threshold=3 exists');
  assert.equal(rule3.action, 'timeout');
  assert.equal(Number(rule3.duration_minutes), 30);
  assert.equal(Number(rule3.warn_threshold), 3);
  console.log('✓ setRule + getRuleForThreshold roundtrip');

  // --- setRule UPSERT (overwrite existing) ---
  await escalations.setRule(GUILD, 3, 'kick', null);
  const rule3upd = await escalations.getRuleForThreshold(GUILD, 3);
  assert.equal(rule3upd.action, 'kick');
  assert.equal(rule3upd.duration_minutes, null);
  console.log('✓ setRule UPSERT overwrites action+duration');

  // --- listRules sorted by threshold ASC ---
  await escalations.setRule(GUILD, 5, 'ban', null);
  await escalations.setRule(GUILD, 10, 'ban', null);
  const list = await escalations.listRules(GUILD);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((r) => Number(r.warn_threshold)), [3, 5, 10]);
  console.log('✓ listRules sorted ASC');

  // --- removeRule returns affectedRows ---
  const removed = await escalations.removeRule(GUILD, 5);
  assert.equal(removed, 1);
  const removedAgain = await escalations.removeRule(GUILD, 5);
  assert.equal(removedAgain, 0, 'second remove returns 0');
  const listAfter = await escalations.listRules(GUILD);
  assert.equal(listAfter.length, 2);
  console.log('✓ removeRule returns affectedRows');

  // --- getRuleForThreshold returns null on miss ---
  const missing = await escalations.getRuleForThreshold(GUILD, 999);
  assert.equal(missing, null);
  console.log('✓ getRuleForThreshold returns null on miss');

  // Cleanup
  await pool.query(`DELETE FROM escalation_rules WHERE guild_id = ?`, [GUILD]);

  console.log('OK — escalations smoke test passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
