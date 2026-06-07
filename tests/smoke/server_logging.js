const assert = require('node:assert/strict');
const { AuditLogEvent } = require('discord.js');

// Mock DB pool before loading config to run without a live database
const db = require('../../src/db');
const mockPool = {
  execute: async (sql, params) => {
    return [[{
      server_log_channel_id: '1509540775535579229',
      log_profile_enabled: 1,
      log_join_leave_enabled: 1,
      log_voice_enabled: 1,
      log_invite_enabled: 1,
      log_roles_enabled: 1,
      log_messages_enabled: 1
    }]];
  },
  query: async (sql, params) => {
    return [[]];
  }
};
db.getPool = () => mockPool;

const config = require('../../src/config');

// Events under test
const guildMemberAdd = require('../../src/events/guildMemberAdd');
const guildMemberRemove = require('../../src/events/guildMemberRemove');
const guildMemberUpdate = require('../../src/events/guildMemberUpdate');
const voiceStateUpdate = require('../../src/events/voiceStateUpdate');

const GUILD_ID = '1509528553933242550';
const SERVER_LOG_CHANNEL_ID = '1509540775535579229';

async function main() {
  console.log('==== Server Logging & Configuration Smoke-Test ====');

  const pool = db.getPool();

  // Seed configuration in the DB
  await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [GUILD_ID]);
  await pool.execute(
    `UPDATE guilds SET 
      server_log_channel_id = ?,
      log_profile_enabled = 1,
      log_join_leave_enabled = 1,
      log_voice_enabled = 1,
      log_invite_enabled = 1,
      log_roles_enabled = 1,
      log_messages_enabled = 1
     WHERE guild_id = ?`,
    [SERVER_LOG_CHANNEL_ID, GUILD_ID]
  );

  // 1. Verify config getters
  assert.equal(await config.getServerLogChannelId(GUILD_ID), SERVER_LOG_CHANNEL_ID);
  assert.equal(await config.isLogProfileEnabled(GUILD_ID), true);
  assert.equal(await config.isLogJoinLeaveEnabled(GUILD_ID), true);
  assert.equal(await config.isLogVoiceEnabled(GUILD_ID), true);
  assert.equal(await config.isLogInviteEnabled(GUILD_ID), true);
  assert.equal(await config.isLogRolesEnabled(GUILD_ID), true);
  assert.equal(await config.isLogMessagesEnabled(GUILD_ID), true);
  console.log('✓ Config getters verified');

  // Mock message logging channel
  let sentEmbeds = [];
  const mockLogChannel = {
    send: async (payload) => {
      sentEmbeds.push(...payload.embeds);
    }
  };

  let mockAuditLogsResult = { entries: new Map() };

  const mockGuild = {
    id: GUILD_ID,
    roles: {
      everyone: { id: GUILD_ID }
    },
    members: {
      me: {
        permissions: {
          has: (perm) => true
        }
      },
      fetch: async (id) => null
    },
    client: {
      user: { id: 'bot_id' }
    },
    invites: {
      fetch: async () => new Map()
    },
    channels: {
      fetch: async (id) => {
        assert.equal(id, SERVER_LOG_CHANNEL_ID);
        return mockLogChannel;
      }
    },
    fetchAuditLogs: async ({ type, limit }) => {
      const filtered = new Map();
      if (mockAuditLogsResult && mockAuditLogsResult.entries) {
        for (const [id, entry] of mockAuditLogsResult.entries) {
          if (type === AuditLogEvent.MemberUpdate && entry.actionType === 'update') {
            filtered.set(id, entry);
          } else if (type === AuditLogEvent.MemberRoleUpdate && entry.actionType === 'roles') {
            filtered.set(id, entry);
          } else if (type === AuditLogEvent.MemberDisconnect && entry.actionType === 'disconnect') {
            filtered.set(id, entry);
          } else if (type === AuditLogEvent.MemberMove && entry.actionType === 'move') {
            filtered.set(id, entry);
          }
        }
      }
      return { entries: filtered };
    }
  };

  // 2. Test Join Log (guildMemberAdd)
  {
    sentEmbeds = [];
    const mockMember = {
      guild: mockGuild,
      client: mockGuild.client,
      user: {
        id: 'user_111',
        tag: 'joiner#0001',
        bot: false,
        createdAt: new Date(Date.now() - 50000000),
        displayAvatarURL: () => 'https://example.com/avatar.png',
      }
    };
    await guildMemberAdd.execute(mockMember);

    // We expect join log to be sent (and captcha or age warning might trigger or skip, but join log definitely sends)
    const joinLog = sentEmbeds.find(e => e.toJSON().title === '📥 Member beigetreten');
    assert.ok(joinLog, 'Should log joining member');
    assert.equal(joinLog.toJSON().fields[0].value.includes('user_111'), true);
    console.log('✓ Join log verified');
  }

  // 3. Test Leave Log (guildMemberRemove)
  {
    sentEmbeds = [];
    const mockMember = {
      guild: mockGuild,
      joinedAt: new Date(Date.now() - 10000000),
      user: {
        id: 'user_222',
        tag: 'leaver#0002',
        displayAvatarURL: () => 'https://example.com/avatar.png',
      }
    };
    await guildMemberRemove.execute(mockMember);

    assert.equal(sentEmbeds.length, 1);
    const log = sentEmbeds[0].toJSON();
    assert.equal(log.title, '📤 Member verlassen');
    assert.equal(log.fields[0].value.includes('user_222'), true);
    console.log('✓ Leave log verified');
  }

  // 4. Test Nickname & Role Changes (guildMemberUpdate)
  {
    sentEmbeds = [];

    // Set up mock audit logs result for nickname and role change
    mockAuditLogsResult = {
      entries: new Map([
        ['entry_nick', {
          id: 'entry_nick',
          actionType: 'update',
          targetId: 'user_333',
          createdTimestamp: Date.now(),
          executor: {
            id: 'moderator_nick_123',
            tag: 'ModNick#1111'
          },
          changes: [
            { key: 'nick', old: 'OldNick', new: 'NewNick' }
          ]
        }],
        ['entry_roles', {
          id: 'entry_roles',
          actionType: 'roles',
          targetId: 'user_333',
          createdTimestamp: Date.now(),
          executor: {
            id: 'moderator_roles_456',
            tag: 'ModRoles#2222'
          },
          changes: []
        }]
      ])
    };

    const oldMember = {
      guild: mockGuild,
      nickname: 'OldNick',
      roles: {
        cache: new Map([['role_1', { id: 'role_1' }]])
      },
      user: {
        id: 'user_333',
        tag: 'updater#0003',
      }
    };

    const newMember = {
      guild: mockGuild,
      nickname: 'NewNick',
      roles: {
        cache: new Map([
          ['role_1', { id: 'role_1' }],
          ['role_2', { id: 'role_2' }]
        ])
      },
      user: {
        id: 'user_333',
        tag: 'updater#0003',
      }
    };

    await guildMemberUpdate.execute(oldMember, newMember);

    // We expect both nick change and role change logs
    const nickLog = sentEmbeds.find(e => e.toJSON().title === '👤 Nickname geändert');
    const roleLog = sentEmbeds.find(e => e.toJSON().title === '🛡️ Rollen geändert');

    assert.ok(nickLog, 'Should log nickname change');
    assert.ok(roleLog, 'Should log role change');

    const nickFields = nickLog.toJSON().fields;
    const oldNickField = nickFields.find(f => f.name === 'Vorher');
    const newNickField = nickFields.find(f => f.name === 'Nachher');
    assert.ok(oldNickField, 'Nickname log should have a "Vorher" field');
    assert.ok(newNickField, 'Nickname log should have a "Nachher" field');
    assert.equal(oldNickField.value, 'OldNick');
    assert.equal(newNickField.value, 'NewNick');

    // Verify executor info
    const hasNickExecutor = nickFields.some(f => f.name === '✍️ Geändert von' && f.value.includes('moderator_nick_123'));
    assert.ok(hasNickExecutor, 'Nickname log should include executor');

    const roleLogObj = roleLog.toJSON();
    const hasRoleExecutor = roleLogObj.fields.some(f => f.name === '✍️ Geändert von' && f.value.includes('moderator_roles_456'));
    assert.ok(hasRoleExecutor, 'Role log should include executor');

    console.log('✓ Profile & Role logs verified');
  }

  // 5. Test Voice State Update (voiceStateUpdate)
  {
    const mockMember = {
      user: {
        id: 'user_444',
        tag: 'voice_user#0004'
      }
    };

    // Case 5.1: Join
    {
      sentEmbeds = [];
      const oldState = {
        guild: mockGuild,
        member: mockMember,
        channelId: null
      };

      const newState = {
        guild: mockGuild,
        member: mockMember,
        channelId: 'voice_channel_1'
      };

      await voiceStateUpdate.execute(oldState, newState);

      assert.equal(sentEmbeds.length, 1);
      const log = sentEmbeds[0].toJSON();
      assert.equal(log.title, '🔊 Voice-Kanal beigetreten');
      assert.equal(log.fields[2].value.includes('voice_channel_1'), true);
      console.log('✓ Voice join log verified');
    }

    // Case 5.2: Disconnect (Leave / Kick)
    {
      sentEmbeds = [];
      mockAuditLogsResult = {
        entries: new Map([
          ['entry_disconnect', {
            id: 'entry_disconnect',
            actionType: 'disconnect',
            targetId: 'user_444',
            createdTimestamp: Date.now(),
            executor: {
              id: 'moderator_disconnect_999',
              tag: 'ModDisconnect#9999'
            }
          }]
        ])
      };

      const oldState = {
        guild: mockGuild,
        member: mockMember,
        channelId: 'voice_channel_1'
      };

      const newState = {
        guild: mockGuild,
        member: mockMember,
        channelId: null
      };

      await voiceStateUpdate.execute(oldState, newState);

      assert.equal(sentEmbeds.length, 1);
      const log = sentEmbeds[0].toJSON();
      assert.equal(log.title, '🔇 Voice-Kanal verlassen');

      const hasDisconnectExecutor = log.fields.some(f => f.name === '✍️ Gekickt von' && f.value.includes('moderator_disconnect_999'));
      assert.ok(hasDisconnectExecutor, 'Voice disconnect log should include executor');
      console.log('✓ Voice disconnect log verified');
    }

    // Case 5.3: Move (Switch / Move)
    {
      sentEmbeds = [];
      mockAuditLogsResult = {
        entries: new Map([
          ['entry_move', {
            id: 'entry_move',
            actionType: 'move',
            targetId: 'user_444',
            createdTimestamp: Date.now(),
            executor: {
              id: 'moderator_move_888',
              tag: 'ModMove#8888'
            }
          }]
        ])
      };

      const oldState = {
        guild: mockGuild,
        member: mockMember,
        channelId: 'voice_channel_1'
      };

      const newState = {
        guild: mockGuild,
        member: mockMember,
        channelId: 'voice_channel_2'
      };

      await voiceStateUpdate.execute(oldState, newState);

      assert.equal(sentEmbeds.length, 1);
      const log = sentEmbeds[0].toJSON();
      assert.equal(log.title, '🔀 Voice-Kanal gewechselt');

      const hasMoveExecutor = log.fields.some(f => f.name === '✍️ Verschoben von' && f.value.includes('moderator_move_888'));
      assert.ok(hasMoveExecutor, 'Voice move log should include executor');
      console.log('✓ Voice move log verified');
    }
  }

  console.log('OK — server_logging smoke test passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
