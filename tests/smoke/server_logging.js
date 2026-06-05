const assert = require('node:assert/strict');
const config = require('../../src/config');
const { getPool } = require('../../src/db');

// Events under test
const guildMemberAdd = require('../../src/events/guildMemberAdd');
const guildMemberRemove = require('../../src/events/guildMemberRemove');
const guildMemberUpdate = require('../../src/events/guildMemberUpdate');
const voiceStateUpdate = require('../../src/events/voiceStateUpdate');

const GUILD_ID = '1509528553933242550';
const SERVER_LOG_CHANNEL_ID = '1509540775535579229';

async function main() {
  console.log('==== Server Logging & Configuration Smoke-Test ====');

  const pool = getPool();

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
    assert.equal(nickLog.toJSON().fields[2].value, 'OldNick');
    assert.equal(nickLog.toJSON().fields[3].value, 'NewNick');
    console.log('✓ Profile & Role logs verified');
  }

  // 5. Test Voice State Update (voiceStateUpdate)
  {
    sentEmbeds = [];
    const mockMember = {
      user: {
        id: 'user_444',
        tag: 'voice_user#0004'
      }
    };

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

  console.log('OK — server_logging smoke test passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
