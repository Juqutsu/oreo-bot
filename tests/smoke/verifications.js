// Run with: node tests/smoke/verifications.js  (braucht MySQL aus .env)
const assert = require('node:assert/strict');

async function main() {
  const v = require('../../src/verifications');
  const { getPool } = require('../../src/db');
  const G = '999999999999999901', U = '999999999999999902';

  await getPool().execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [G]);
  await v.remove(G, U);

  await v.trackJoin(G, U, null, 15);
  let [rows] = await getPool().execute(
    'SELECT * FROM pending_verifications WHERE guild_id = ? AND user_id = ?', [G, U]);
  assert.equal(rows.length, 1, 'trackJoin inserts row');

  // Deadline in die Vergangenheit setzen → muss in listExpired auftauchen
  await getPool().execute(
    'UPDATE pending_verifications SET deadline_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE guild_id = ? AND user_id = ?',
    [G, U]);
  const expired = await v.listExpired();
  assert.ok(expired.some(r => String(r.guild_id) === G && String(r.user_id) === U), 'expired row listed');

  await v.markVerified(G, U);
  [rows] = await getPool().execute(
    'SELECT * FROM pending_verifications WHERE guild_id = ? AND user_id = ?', [G, U]);
  assert.equal(rows.length, 0, 'markVerified removes row');

  console.log('OK — verifications DAL passed');
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
