// Run with: node tests/smoke/announcements.js  (braucht MySQL aus .env)
const assert = require('node:assert/strict');

async function main() {
  const a = require('../../src/announcements');
  const { getPool } = require('../../src/db');
  const G = '999999999999999801';

  await getPool().execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [G]);
  await getPool().execute('DELETE FROM announcements WHERE guild_id = ?', [G]);

  console.log('Running Test 1: create + get...');
  const id = await a.createAnnouncement({
    guildId: G, channelId: '111', messageId: '222', authorId: '333',
    title: 'Test-Titel', description: 'Test-Beschreibung', color: 0x57f287,
    imageUrl: 'https://example.com/img.png', pingRoleId: null,
  });
  assert.ok(Number.isInteger(id) && id > 0, 'createAnnouncement returns numeric id');
  const row = await a.getAnnouncement(G, id);
  assert.equal(row.title, 'Test-Titel');
  assert.equal(String(row.message_id), '222');
  assert.equal(row.status, 'posted');
  console.log('   Test 1 passed');

  console.log('Running Test 2: listRecent...');
  const list = await a.listRecent(G, 25);
  assert.ok(list.some((r) => Number(r.id) === id), 'created row listed');
  console.log('   Test 2 passed');

  console.log('Running Test 3: update...');
  await a.updateAnnouncement(G, id, { title: 'Neu', description: 'Neu-Desc', imageUrl: null, editedBy: '444' });
  const edited = await a.getAnnouncement(G, id);
  assert.equal(edited.title, 'Neu');
  assert.equal(edited.image_url, null);
  assert.ok(edited.edited_at, 'edited_at set');
  assert.equal(String(edited.edited_by), '444');
  console.log('   Test 3 passed');

  console.log('Running Test 4: markDeleted (soft) verschwindet aus listRecent, get liefert weiter...');
  await a.markDeleted(G, id);
  const listAfter = await a.listRecent(G, 25);
  assert.ok(!listAfter.some((r) => Number(r.id) === id), 'deleted row not listed');
  const still = await a.getAnnouncement(G, id);
  assert.equal(still.status, 'deleted', 'get still returns row incl. status');
  console.log('   Test 4 passed');

  console.log('OK — announcements DAL smoke test passed');
  process.exit(0);
}
main().catch((err) => { console.error('FAIL', err); process.exit(1); });
