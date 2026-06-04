// Smoke test for advanced moderation features (Stage 10)
// Run with: node --env-file=.env tests/smoke/advanced_features.js

const assert = require('node:assert/strict');
const { getPool } = require('../../src/db');
const cases = require('../../src/cases');
const config = require('../../src/config');
const { runDecayAndExpiry } = require('../../src/background');
const softban = require('../../src/commands/softban');

const GUILD_ID = '1509528553933242550';
const MODLOG_CHANNEL_ID = '1509540775535579229';
const MUTED_ROLE_ID = '1509541112223334444';

async function main() {
  console.log('==== Advanced Moderation Features Smoke-Test ====');

  const pool = getPool();

  // 0. Setup guild configuration
  await pool.query(
    `INSERT INTO guilds (guild_id, mod_log_channel_id, muted_role_id, warn_decay_days)
     VALUES (?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE 
       mod_log_channel_id = VALUES(mod_log_channel_id),
       muted_role_id = VALUES(muted_role_id),
       warn_decay_days = VALUES(warn_decay_days)`,
    [GUILD_ID, MODLOG_CHANNEL_ID, MUTED_ROLE_ID]
  );

  // Clear previous test infractions to guarantee a clean state
  await pool.query(
    "DELETE FROM infractions WHERE user_id IN ('1509540000000000001', '1509540000000000003', '1509540000000000004', '1509540000000000005')"
  );

  let sendEmbeds = [];
  const mockChannel = {
    send: async (payload) => {
      sendEmbeds.push(...payload.embeds);
    }
  };

  let unbannedUsers = [];
  let removedRoles = [];

  const mockMember = {
    bannable: true,
    roles: {
      remove: async (roleId, reason) => {
        removedRoles.push({ roleId, reason });
      }
    }
  };

  const mockGuild = {
    id: GUILD_ID,
    ownerId: '1509540000000000099',
    members: {
      me: { id: '1509540000000000000' },
      unban: async (userId, reason) => {
        unbannedUsers.push({ userId, reason });
      },
      fetch: async (userId) => {
        return mockMember;
      },
      ban: async (userId, options) => {
        // Mock ban for softban test
      }
    },
    channels: {
      fetch: async (id) => {
        assert.equal(id, MODLOG_CHANNEL_ID, 'Should fetch modlog channel');
        return mockChannel;
      }
    }
  };

  const mockClient = {
    user: { id: '1509540000000000000' },
    guilds: {
      fetch: async (id) => {
        assert.equal(id, GUILD_ID);
        return mockGuild;
      }
    },
    users: {
      fetch: async (id) => {
        return { id, username: 'testuser', tag: 'testuser#1234', displayAvatarURL: () => 'https://example.com/avatar.png' };
      }
    },
    channels: {
      fetch: async (id) => {
        assert.equal(id, MODLOG_CHANNEL_ID);
        return mockChannel;
      }
    }
  };

  // Test 1: Expired Temp-Ban processing
  {
    console.log('Running Test 1: Expired Temp-Ban...');
    unbannedUsers = [];
    sendEmbeds = [];

    // Create an active ban case
    const result = await cases.createCase({
      guildId: GUILD_ID,
      userId: '1509540000000000001',
      moderatorId: '1509540000000000002',
      type: 'ban',
      reason: 'Tempban test',
      durationMs: 60000,
      expiresAt: new Date(),
    });

    // Backdate the expiration to 5 minutes ago
    await pool.query('UPDATE infractions SET expires_at = DATE_SUB(NOW(), INTERVAL 5 MINUTE) WHERE id = ?', [result.infractionId]);

    // Run the background decay and expiry worker
    await runDecayAndExpiry(mockClient);

    // Verify unban was called on Discord
    assert.equal(unbannedUsers.length, 1);
    assert.equal(unbannedUsers[0].userId, '1509540000000000001');

    // Verify the ban infraction is now marked active = 0 in database
    const [rows] = await pool.query('SELECT active FROM infractions WHERE id = ?', [result.infractionId]);
    assert.equal(rows[0].active, 0, 'Ban should be marked inactive');

    // Verify a new unban case was created
    const [unbanCases] = await pool.query("SELECT * FROM infractions WHERE type = 'unban' AND user_id = '1509540000000000001' AND source = 'system'");
    assert.equal(unbanCases.length, 1, 'Should create unban case');

    // Verify log embed was sent to modlog
    assert.equal(sendEmbeds.length, 1);
    const embed = sendEmbeds[0].toJSON();
    assert.equal(embed.title, '🔓 User entbannt');
    assert.ok(embed.fields.find(f => f.name === '👤 User' && f.value.includes('1509540000000000001')));

    console.log('   Test 1 passed');
  }

  // Test 2: Expired Mute processing
  {
    console.log('Running Test 2: Expired Mute...');
    removedRoles = [];
    sendEmbeds = [];

    // Create an active mute case
    const result = await cases.createCase({
      guildId: GUILD_ID,
      userId: '1509540000000000003',
      moderatorId: '1509540000000000002',
      type: 'mute',
      reason: 'Mute test',
      durationMs: 60000,
      expiresAt: new Date(),
    });

    // Backdate expiration
    await pool.query('UPDATE infractions SET expires_at = DATE_SUB(NOW(), INTERVAL 5 MINUTE) WHERE id = ?', [result.infractionId]);

    // Run worker
    await runDecayAndExpiry(mockClient);

    // Verify role remove was called
    assert.equal(removedRoles.length, 1);
    assert.equal(removedRoles[0].roleId, MUTED_ROLE_ID);

    // Verify database active is 0
    const [rows] = await pool.query('SELECT active FROM infractions WHERE id = ?', [result.infractionId]);
    assert.equal(rows[0].active, 0, 'Mute should be marked inactive');

    // Verify new unmute case
    const [unmuteCases] = await pool.query("SELECT * FROM infractions WHERE type = 'unmute' AND user_id = '1509540000000000003' AND source = 'system'");
    assert.equal(unmuteCases.length, 1, 'Should create unmute case');

    // Verify log embed sent
    assert.equal(sendEmbeds.length, 1);
    const embed = sendEmbeds[0].toJSON();
    assert.equal(embed.title, '🔊 Stummschaltung aufgehoben');

    console.log('   Test 2 passed');
  }

  // Test 3: Warn Decay processing
  {
    console.log('Running Test 3: Warn Decay...');
    await pool.query('UPDATE guilds SET warn_decay_days = 30 WHERE guild_id = ?', [GUILD_ID]);

    // Create two warnings
    const resultA = await cases.createCase({ guildId: GUILD_ID, userId: '1509540000000000004', moderatorId: '1509540000000000002', type: 'warn', reason: 'Old warn' });
    const resultB = await cases.createCase({ guildId: GUILD_ID, userId: '1509540000000000004', moderatorId: '1509540000000000002', type: 'warn', reason: 'New warn' });

    // Backdate warn A to 40 days ago, warn B to 10 days ago
    await pool.query('UPDATE infractions SET created_at = DATE_SUB(NOW(), INTERVAL 40 DAY) WHERE id = ?', [resultA.infractionId]);
    await pool.query('UPDATE infractions SET created_at = DATE_SUB(NOW(), INTERVAL 10 DAY) WHERE id = ?', [resultB.infractionId]);

    // Run worker
    await runDecayAndExpiry(mockClient);

    // Verify warn A is inactive and warn B is active
    const [rowsA] = await pool.query('SELECT active FROM infractions WHERE id = ?', [resultA.infractionId]);
    const [rowsB] = await pool.query('SELECT active FROM infractions WHERE id = ?', [resultB.infractionId]);

    assert.equal(rowsA[0].active, 0, 'Old warn should decay (active=0)');
    assert.equal(rowsB[0].active, 1, 'New warn should remain active (active=1)');

    console.log('   Test 3 passed');
  }

  // Test 4: Softban command execution
  {
    console.log('Running Test 4: Softban command...');
    sendEmbeds = [];

    let banCalled = false;
    let unbanCalled = false;

    const softbanGuild = {
      ...mockGuild,
      members: {
        ...mockGuild.members,
        ban: async (userId, options) => {
          assert.equal(userId, '1509540000000000005');
          assert.ok(options.deleteMessageSeconds > 0);
          banCalled = true;
        },
        unban: async (userId, reason) => {
          assert.equal(userId, '1509540000000000005');
          unbanCalled = true;
        }
      }
    };

    let replyMsg = null;
    const mockInteraction = {
      guildId: GUILD_ID,
      guild: softbanGuild,
      member: {
        id: '1509540000000000002',
        user: { tag: 'mod#1234' },
        roles: { highest: { comparePositionTo: () => 1 } }
      },
      client: mockClient,
      options: {
        getUser: (name) => {
          assert.equal(name, 'target');
          return { id: '1509540000000000005', username: 'softuser', tag: 'softuser#7777', displayAvatarURL: () => 'https://example.com/avatar.png' };
        },
        getString: (name) => {
          return 'Purging spam messages';
        }
      },
      reply: async (payload) => {
        replyMsg = payload.content;
      },
      followUp: async (payload) => {
        // Mock followUp
      }
    };

    await softban.execute(mockInteraction);

    // Verify ban and unban was executed
    assert.ok(banCalled, 'ban should be called');
    assert.ok(unbanCalled, 'unban should be called');

    // Verify softban case was created in DB with active = 0
    const [rows] = await pool.query("SELECT * FROM infractions WHERE type = 'softban' AND user_id = '1509540000000000005'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].active, 0, 'Softban case should be inactive');

    // Verify modlog received the embed
    assert.equal(sendEmbeds.length, 1);
    const embed = sendEmbeds[0].toJSON();
    assert.equal(embed.title, 'ℹ️ User soft-gebannt');

    console.log('   Test 4 passed');
  }

  console.log('OK — advanced_features smoke-test passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
