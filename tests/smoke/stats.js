// Smoke test for Stats Command (Stage 12)
// Run with: node --env-file=.env tests/smoke/stats.js

const assert = require('node:assert/strict');
const { getPool } = require('../../src/db');
const stats = require('../../src/commands/stats');

const GUILD_ID = '1509528553933242550';
const MOD_ID = '1509540000000000002';
const USER_ID = '1509540000000000005';

async function main() {
  console.log('==== Stats Command Smoke-Test ====');

  const pool = getPool();

  // Clear previous test infractions to guarantee a clean state
  await pool.query('DELETE FROM infractions WHERE guild_id = ?', [GUILD_ID]);
  await pool.query('DELETE FROM reports WHERE guild_id = ?', [GUILD_ID]);

  // Insert mock infractions
  await pool.query(
    `INSERT INTO infractions (guild_id, case_number, user_id, moderator_id, type, reason, active, created_at)
     VALUES 
       (?, 1, ?, ?, 'warn', 'Warn 1', 1, NOW()),
       (?, 2, ?, ?, 'warn', 'Warn 2', 0, NOW()),
       (?, 3, ?, ?, 'mute', 'Mute 1', 1, NOW()),
       (?, 4, ?, ?, 'ban', 'Ban 1', 1, NOW())`,
    [
      GUILD_ID, USER_ID, MOD_ID,
      GUILD_ID, USER_ID, MOD_ID,
      GUILD_ID, USER_ID, MOD_ID,
      GUILD_ID, USER_ID, MOD_ID
    ]
  );

  // Insert mock reports
  await pool.query(
    `INSERT INTO reports (guild_id, reporter_id, reported_user_id, reason, status, created_at)
     VALUES 
       (?, ?, ?, 'Reason 1', 'resolved', NOW()),
       (?, ?, ?, 'Reason 2', 'open', NOW())`,
    [
      GUILD_ID, USER_ID, USER_ID,
      GUILD_ID, USER_ID, USER_ID
    ]
  );

  let repliedEmbeds = [];

  const mockInteraction = {
    guildId: GUILD_ID,
    guild: {
      name: 'Test Server',
      roles: {
        cache: new Map(),
        fetch: async () => null
      }
    },
    member: {
      id: MOD_ID,
      roles: {
        cache: new Map()
      }
    },
    user: { id: MOD_ID },
    options: {
      getSubcommand: () => 'server',
      getUser: (name) => {
        if (name === 'target') return { id: USER_ID, username: 'testuser', displayAvatarURL: () => 'https://example.com/avatar.png' };
        return null;
      }
    },
    reply: async (payload) => {
      repliedEmbeds.push(...(payload.embeds || []));
    }
  };

  // Test 1: /stats server
  {
    console.log('Running Test 1: /stats server...');
    repliedEmbeds = [];

    mockInteraction.options.getSubcommand = () => 'server';

    await stats.execute(mockInteraction);

    assert.equal(repliedEmbeds.length, 1);
    const embed = repliedEmbeds[0].toJSON();
    assert.equal(embed.title, '📊 Server-Statistiken für Test Server');
    
    const casesField = embed.fields.find(f => f.name === '📂 Gesamt-Fälle (Infractions)');
    assert.equal(casesField.value, '4');

    const breakdownField = embed.fields.find(f => f.name === '⚙️ Aktionen-Verteilung');
    assert.ok(breakdownField.value.includes('**warn**: 2'));
    assert.ok(breakdownField.value.includes('**mute**: 1'));
    assert.ok(breakdownField.value.includes('**ban**: 1'));

    const reportsField = embed.fields.find(f => f.name === '📋 Berichte-Statistik');
    assert.ok(reportsField.value.includes('**resolved**: 1'));
    assert.ok(reportsField.value.includes('**open**: 1'));

    console.log('   Test 1 passed');
  }

  // Test 2: /stats moderator
  {
    console.log('Running Test 2: /stats moderator...');
    repliedEmbeds = [];

    mockInteraction.options.getSubcommand = () => 'moderator';
    mockInteraction.options.getUser = (name) => {
      if (name === 'target') return { id: MOD_ID, username: 'moduser', displayAvatarURL: () => 'https://example.com/avatar.png' };
      return null;
    };

    // Mock perms check bypass for tests
    const perms = require('../../src/perms');
    const originalRequireTier = perms.requireTier;
    perms.requireTier = async () => true;

    await stats.execute(mockInteraction);

    // Restore original perms helper
    perms.requireTier = originalRequireTier;

    assert.equal(repliedEmbeds.length, 1);
    const embed = repliedEmbeds[0].toJSON();
    assert.equal(embed.title, '👮 Moderator-Statistik: moduser');

    const totalField = embed.fields.find(f => f.name === '🔧 Aktionen gesamt');
    assert.equal(totalField.value, '4');

    const lastField = embed.fields.find(f => f.name === '🔄 Letzte Aktion');
    assert.ok(lastField.value.includes('Case #4 (ban)'));

    console.log('   Test 2 passed');
  }

  // Test 3: /stats user
  {
    console.log('Running Test 3: /stats user...');
    repliedEmbeds = [];

    mockInteraction.options.getSubcommand = () => 'user';
    mockInteraction.options.getUser = (name) => {
      if (name === 'target') return { id: USER_ID, username: 'victimuser', displayAvatarURL: () => 'https://example.com/avatar.png' };
      return null;
    };

    await stats.execute(mockInteraction);

    assert.equal(repliedEmbeds.length, 1);
    const embed = repliedEmbeds[0].toJSON();
    assert.equal(embed.title, '👤 User-Historie: victimuser');

    const totalField = embed.fields.find(f => f.name === '📂 Gesamt-Maßnahmen');
    assert.equal(totalField.value, '4');

    const lastField = embed.fields.find(f => f.name === '🔄 Letzte Maßnahme');
    assert.ok(lastField.value.includes('Case #4 (ban)'));

    console.log('   Test 3 passed');
  }

  console.log('OK — stats smoke-test passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
