// Smoke test for Account-Age-Check guildMemberAdd event handler
// Run with: node --env-file=.env tests/smoke/account_age_check.js

const assert = require('node:assert/strict');
const guildMemberAdd = require('../../src/events/guildMemberAdd');
const { getPool } = require('../../src/db');

const GUILD_ID = '1509528553933242550';
const MODLOG_CHANNEL_ID = '1509540775535579229';

async function main() {
  console.log('==== Account-Age-Check event handler smoke-test ====');

  const pool = getPool();

  // Ensure guild row exists with configured modlog and min_account_age_days
  async function configureGuild(minDays) {
    await pool.query(
      `INSERT INTO guilds (guild_id, mod_log_channel_id, min_account_age_days, captcha_enabled, server_log_channel_id, log_join_leave_enabled, log_invite_enabled, log_messages_enabled)
       VALUES (?, ?, ?, 0, NULL, 0, 0, 0)
       ON DUPLICATE KEY UPDATE 
         mod_log_channel_id = VALUES(mod_log_channel_id),
         min_account_age_days = VALUES(min_account_age_days),
         captcha_enabled = 0,
         server_log_channel_id = NULL,
         log_join_leave_enabled = 0,
         log_invite_enabled = 0,
         log_messages_enabled = 0`,
      [GUILD_ID, MODLOG_CHANNEL_ID, minDays]
    );
  }

  let sendEmbeds = [];
  const mockChannel = {
    send: async (payload) => {
      sendEmbeds.push(...payload.embeds);
    }
  };

  const mockGuild = {
    id: GUILD_ID,
    channels: {
      fetch: async (id) => {
        assert.equal(id, MODLOG_CHANNEL_ID, 'Should fetch the configured modlog channel');
        return mockChannel;
      }
    }
  };

  // Test 1: Account age is 2 days, threshold is 7 days -> triggers warning
  {
    console.log('Running Test 1: Young account with threshold enabled...');
    sendEmbeds = [];
    await configureGuild(7);

    const createdAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
    const mockMember = {
      guild: mockGuild,
      user: {
        id: 'user_111',
        tag: 'young_user#0001',
        bot: false,
        createdAt,
        displayAvatarURL: () => 'https://example.com/avatar.png',
      }
    };

    await guildMemberAdd.execute(mockMember);

    assert.equal(sendEmbeds.length, 1, 'Should log a warning for new account');
    const embed = sendEmbeds[0].toJSON();
    assert.equal(embed.title, '🚨 Verdächtiger Account-Beitritt');
    assert.ok(embed.fields.find(f => f.name === '👤 User' && f.value.includes('user_111')));
    assert.ok(embed.fields.find(f => f.name === '📅 Registriert vor' && f.value.includes('Tage')));
    console.log('   Test 1 passed');
  }

  // Test 2: Account age is 10 days, threshold is 7 days -> does NOT trigger warning
  {
    console.log('Running Test 2: Old account with threshold enabled...');
    sendEmbeds = [];
    await configureGuild(7);

    const createdAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
    const mockMember = {
      guild: mockGuild,
      user: {
        id: 'user_222',
        tag: 'old_user#0002',
        bot: false,
        createdAt,
        displayAvatarURL: () => 'https://example.com/avatar.png',
      }
    };

    await guildMemberAdd.execute(mockMember);

    assert.equal(sendEmbeds.length, 0, 'Should NOT log a warning for old account');
    console.log('   Test 2 passed');
  }

  // Test 3: Account age is 2 days, threshold is 0 (disabled) -> does NOT trigger warning
  {
    console.log('Running Test 3: Young account with threshold disabled (0)...');
    sendEmbeds = [];
    await configureGuild(0);

    const createdAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
    const mockMember = {
      guild: mockGuild,
      user: {
        id: 'user_333',
        tag: 'young_user_disabled#0003',
        bot: false,
        createdAt,
        displayAvatarURL: () => 'https://example.com/avatar.png',
      }
    };

    await guildMemberAdd.execute(mockMember);

    assert.equal(sendEmbeds.length, 0, 'Should NOT log a warning when disabled');
    console.log('   Test 3 passed');
  }

  // Test 4: Bot account, age is 1 day, threshold is 7 days -> does NOT trigger warning
  {
    console.log('Running Test 4: Bot account (ignored)...');
    sendEmbeds = [];
    await configureGuild(7);

    const createdAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago
    const mockMember = {
      guild: mockGuild,
      user: {
        id: 'bot_444',
        tag: 'some_bot#9999',
        bot: true,
        createdAt,
        displayAvatarURL: () => 'https://example.com/avatar.png',
      }
    };

    await guildMemberAdd.execute(mockMember);

    assert.equal(sendEmbeds.length, 0, 'Should NOT log a warning for bot');
    console.log('   Test 4 passed');
  }

  console.log('OK — account_age_check smoke-test passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
