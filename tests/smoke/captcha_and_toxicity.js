// Smoke test for Captcha Verification & Toxicity Filter (Stage 11)
// Run with: node --env-file=.env tests/smoke/captcha_and_toxicity.js

const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');
const { getPool } = require('../../src/db');
const config = require('../../src/config');
const obfuscation = require('../../src/obfuscation');
const captcha = require('../../src/interactions/captcha');
const messageCreate = require('../../src/events/messageCreate');

const GUILD_ID = '1509528553933242550';
const MODLOG_CHANNEL_ID = '1509540775535579229';
const VERIFIED_ROLE_ID = '1509541112223334555';

async function main() {
  console.log('==== Captcha Verification & Toxicity Filter Smoke-Test ====');

  const pool = getPool();

  // Setup guild configuration
  await pool.query(
    `INSERT INTO guilds (guild_id, mod_log_channel_id, captcha_enabled, verified_role_id, toxicity_enabled, toxicity_action, captcha_channel_id)
     VALUES (?, ?, 1, ?, 1, 'warn', NULL)
     ON DUPLICATE KEY UPDATE 
       mod_log_channel_id = VALUES(mod_log_channel_id),
       captcha_enabled = VALUES(captcha_enabled),
       verified_role_id = VALUES(verified_role_id),
       toxicity_enabled = VALUES(toxicity_enabled),
       toxicity_action = VALUES(toxicity_action),
       captcha_channel_id = NULL`,
    [GUILD_ID, MODLOG_CHANNEL_ID, VERIFIED_ROLE_ID]
  );

  // Clear previous bad words
  await pool.query('DELETE FROM bad_words WHERE guild_id = ?', [GUILD_ID]);
  await config.addBadWord(GUILD_ID, 'badword');
  await config.addBadWord(GUILD_ID, 'spam');

  // Test 1: Obfuscation Normalizer
  {
    console.log('Running Test 1: Obfuscation Normalizer...');

    assert.equal(obfuscation.normalize('b.a.d.w.0.r.d'), 'badword');
    assert.equal(obfuscation.normalize('b__a__d__w__o__r__d'), 'badword');
    assert.equal(obfuscation.normalize('baaaaadwoooordd'), 'badword');
    assert.equal(obfuscation.normalize('sp4m'), 'spam');
    assert.equal(obfuscation.normalize('s.p.a.m.'), 'spam');
    assert.equal(obfuscation.normalize('s__p__a__m'), 'spam');
    assert.equal(obfuscation.normalize('sspppaaammm'), 'spam');

    console.log('   Test 1 passed');
  }

  // Mocks for interaction and client
  let assignedRoles = [];
  let kickedUsers = [];
  let deletedChannels = [];
  let sentEmbeds = [];

  const mockChannel = {
    id: MODLOG_CHANNEL_ID,
    name: 'mod-log',
    send: async (payload) => {
      sentEmbeds.push(...(payload.embeds || []));
      return { id: 'msg_999', delete: async () => {} };
    },
    delete: async (reason) => {
      deletedChannels.push(reason);
    }
  };

  const mockMember = {
    id: '1509540000000000001',
    user: { id: '1509540000000000001', tag: 'testuser#1111', displayAvatarURL: () => 'https://example.com' },
    roles: {
      add: async (role, reason) => {
        const rId = typeof role === 'string' ? role : role.id;
        assignedRoles.push({ roleId: rId, reason });
      }
    },
    kick: async (reason) => {
      kickedUsers.push(reason);
    }
  };

  const mockGuild = {
    id: GUILD_ID,
    name: 'Test Guild',
    roles: {
      cache: {
        get: (id) => ({ id, name: 'Member' })
      },
      fetch: async (id) => ({ id, name: 'Member' })
    },
    members: {
      fetch: async (id) => {
        return mockMember;
      },
      me: { id: '1509540000000000000' }
    },
    channels: {
      fetch: async (id) => {
        return mockChannel;
      }
    }
  };

  const mockClient = {
    user: { id: '1509540000000000000' },
    guilds: {
      fetch: async (id) => mockGuild
    },
    channels: {
      fetch: async (id) => mockChannel
    }
  };

  // Test 2: Captcha Correct Action
  {
    console.log('Running Test 2: Captcha Correct Answer...');
    assignedRoles = [];
    deletedChannels = [];
    sentEmbeds = [];

    const mockInteraction = {
      customId: `captcha_correct_1509540000000000001_1_🍎`,
      user: { id: '1509540000000000001' },
      guild: mockGuild,
      channel: mockChannel,
      deferUpdate: async () => {},
      reply: async () => {}
    };

    const handled = await captcha.dispatch(mockInteraction);
    assert.ok(handled, 'Should handle captcha correct action');

    // Wait a brief moment for async tasks (role addition, channel deletion timeout)
    await new Promise((resolve) => setTimeout(resolve, 1600));

    assert.equal(assignedRoles.length, 1);
    assert.equal(assignedRoles[0].roleId, VERIFIED_ROLE_ID);
    assert.equal(deletedChannels.length, 1);
    assert.equal(sentEmbeds.length, 1);
    assert.equal(sentEmbeds[0].toJSON().title, '✅ User verifiziert');

    console.log('   Test 2 passed');
  }

  // Test 3: Captcha Wrong Action (Failure -> Kick)
  {
    console.log('Running Test 3: Captcha Wrong Answer -> Kick...');
    kickedUsers = [];
    deletedChannels = [];
    sentEmbeds = [];

    let replies = [];
    const mockInteraction = {
      customId: `captcha_wrong_1509540000000000001_3_🍌`,
      user: { id: '1509540000000000001' },
      guild: mockGuild,
      channel: mockChannel,
      deferUpdate: async () => {},
      reply: async (payload) => {
        replies.push(payload);
      }
    };

    const handled = await captcha.dispatch(mockInteraction);
    assert.ok(handled, 'Should handle captcha wrong action');

    await new Promise((resolve) => setTimeout(resolve, 1600));

    assert.equal(kickedUsers.length, 1);
    assert.equal(kickedUsers[0], 'Oreo: Captcha-Verifizierung fehlgeschlagen (3 Fehlversuche)');
    assert.equal(deletedChannels.length, 1);

    console.log('   Test 3 passed');
  }

  // Test 4: Toxicity Filter deletion, warn, and mute
  {
    console.log('Running Test 4: Toxicity Filter Screening...');

    // Warm up DB with clean slate of cases
    await pool.query('DELETE FROM infractions WHERE user_id = ?', [mockMember.id]);

    let deleted = false;
    let warningSent = false;

    const mockMessage = {
      content: 'Hey, you are a b.a.d.w.0.r.d!',
      author: { id: mockMember.id, bot: false, username: 'testuser', displayAvatarURL: () => 'https://example.com/avatar.png' },
      member: {
        permissions: {
          has: () => false
        },
        roles: {
          add: async () => {}
        }
      },
      guild: mockGuild,
      client: mockClient,
      channel: {
        send: async (text) => {
          warningSent = true;
          return { delete: async () => {} };
        }
      },
      delete: async () => {
        deleted = true;
      }
    };

    // Test with warn action
    await pool.query("UPDATE guilds SET toxicity_action = 'warn' WHERE guild_id = ?", [GUILD_ID]);
    await messageCreate.execute(mockMessage);

    assert.ok(deleted, 'Message should be deleted');
    assert.ok(warningSent, 'Warning message should be sent to channel');

    const [warnCases] = await pool.query(
      "SELECT * FROM infractions WHERE user_id = ? AND type = 'warn' AND source = 'automod'",
      [mockMember.id]
    );
    assert.equal(warnCases.length, 1, 'Should log a warning infraction in database');

    // Test with mute action
    deleted = false;
    warningSent = false;
    let roleAssigned = false;
    const mockMuteMessage = {
      ...mockMessage,
      content: 's_p_a_m is not allowed!',
      member: {
        permissions: { has: () => false },
        roles: {
          add: async (role, reason) => {
            roleAssigned = true;
          }
        }
      }
    };

    await pool.query("UPDATE guilds SET toxicity_action = 'mute' WHERE guild_id = ?", [GUILD_ID]);
    await messageCreate.execute(mockMuteMessage);

    assert.ok(deleted, 'Muted message should be deleted');
    assert.ok(roleAssigned, 'Muted role should be assigned to toxic member');

    const [muteCases] = await pool.query(
      "SELECT * FROM infractions WHERE user_id = ? AND type = 'mute' AND source = 'automod'",
      [mockMember.id]
    );
    assert.equal(muteCases.length, 1, 'Should log a mute infraction in database');

    console.log('   Test 4 passed');
  }

  // Test 5: Global Verification Channel
  {
    console.log('Running Test 5: Global Verification Channel...');
    assignedRoles = [];
    deletedChannels = [];
    sentEmbeds = [];
    let editReplies = [];
    let replies = [];

    // Set global captcha channel in DB
    await pool.query("UPDATE guilds SET captcha_channel_id = ? WHERE guild_id = ?", [mockChannel.id, GUILD_ID]);

    // 1. Click global start button
    const mockStartInteraction = {
      customId: 'captcha_global_start',
      user: { id: '1509540000000000001' },
      member: { roles: { cache: new Map() } },
      guild: mockGuild,
      channel: mockChannel,
      reply: async (payload) => {
        replies.push(payload);
      }
    };

    let handled = await captcha.dispatch(mockStartInteraction);
    assert.ok(handled, 'Should handle global start button');
    assert.equal(replies.length, 1, 'Should send ephemeral captcha reply');
    assert.ok(replies[0].flags === MessageFlags.Ephemeral || replies[0].ephemeral, 'Reply should be ephemeral');

    // 2. Click correct emoji
    const mockCorrectInteraction = {
      customId: `captcha_correct_1509540000000000001_1_🍎`,
      user: { id: '1509540000000000001' },
      guild: mockGuild,
      channel: mockChannel,
      deferUpdate: async () => {},
      editReply: async (payload) => {
        editReplies.push(payload);
      }
    };

    handled = await captcha.dispatch(mockCorrectInteraction);
    assert.ok(handled, 'Should handle captcha correct action');

    await new Promise((resolve) => setTimeout(resolve, 1600));

    assert.equal(assignedRoles.length, 1, 'Should assign verified role');
    assert.equal(deletedChannels.length, 0, 'Should NOT delete the global verification channel');
    assert.equal(editReplies.length, 1, 'Should update ephemeral reply with success text');
    assert.ok(editReplies[0].content.includes('Erfolgreich verifiziert'), 'Success text should match');

    console.log('   Test 5 passed');
  }

  console.log('OK — captcha_and_toxicity smoke-test passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
