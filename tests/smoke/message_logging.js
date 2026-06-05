// Smoke test for Message-Logging event handlers
// Run with: node --env-file=.env tests/smoke/message_logging.js

const assert = require('node:assert/strict');
const messageDelete = require('../../src/events/messageDelete');
const messageUpdate = require('../../src/events/messageUpdate');
const { getPool } = require('../../src/db');

const GUILD_ID = '1509528553933242550';
const MSGLOG_CHANNEL_ID = '1509540775535579229';

async function main() {
  console.log('==== Message-Logging event handlers smoke-test ====');

  const pool = getPool();

  // Ensure guild row exists and has a configured msg_log_channel_id
  await pool.query(
    `INSERT INTO guilds (guild_id, msg_log_channel_id, log_messages_enabled)
     VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE 
       msg_log_channel_id = VALUES(msg_log_channel_id),
       log_messages_enabled = 1`,
    [GUILD_ID, MSGLOG_CHANNEL_ID]
  );

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
        assert.equal(id, MSGLOG_CHANNEL_ID, 'Should fetch the configured msglog channel');
        return mockChannel;
      }
    }
  };

  // Test 1: messageDelete (cached)
  {
    console.log('Running Test 1: messageDelete (cached)...');
    sendEmbeds = [];

    const mockMessage = {
      guild: mockGuild,
      channel: { id: 'channel_123' },
      author: {
        id: 'user_123',
        username: 'testuser',
        globalName: 'Test User',
        bot: false,
      },
      content: 'This message was deleted!',
      attachments: new Map(),
    };

    await messageDelete.execute(mockMessage);

    assert.equal(sendEmbeds.length, 1);
    const embed = sendEmbeds[0].toJSON();
    assert.equal(embed.title, '🗑️ Nachricht gelöscht');
    assert.ok(embed.fields.find(f => f.name === '📝 Inhalt' && f.value === 'This message was deleted!'));
    console.log('   Test 1 passed');
  }

  // Test 2: messageDelete (partial / not in cache)
  {
    console.log('Running Test 2: messageDelete (partial)...');
    sendEmbeds = [];

    const mockMessage = {
      guild: mockGuild,
      channel: { id: 'channel_123' },
      author: null, // author is unknown
      content: null, // content is unknown
      attachments: null,
    };

    await messageDelete.execute(mockMessage);

    assert.equal(sendEmbeds.length, 1);
    const embed = sendEmbeds[0].toJSON();
    assert.equal(embed.title, '🗑️ Nachricht gelöscht');
    assert.ok(embed.fields.find(f => f.name === '👤 User' && f.value === 'Unbekannter User'));
    assert.ok(embed.fields.find(f => f.name === '📝 Inhalt' && f.value === '*(Inhalt nicht im Cache)*'));
    console.log('   Test 2 passed');
  }

  // Test 3: messageUpdate (cached old and new)
  {
    console.log('Running Test 3: messageUpdate (cached)...');
    sendEmbeds = [];

    const oldMessage = {
      guild: mockGuild,
      channel: { id: 'channel_123' },
      author: {
        id: 'user_123',
        username: 'testuser',
        globalName: 'Test User',
        bot: false,
      },
      content: 'Original content',
    };

    const newMessage = {
      guild: mockGuild,
      channel: { id: 'channel_123' },
      author: {
        id: 'user_123',
        username: 'testuser',
        globalName: 'Test User',
        bot: false,
      },
      content: 'Edited content',
    };

    await messageUpdate.execute(oldMessage, newMessage);

    assert.equal(sendEmbeds.length, 1);
    const embed = sendEmbeds[0].toJSON();
    assert.equal(embed.title, '📝 Nachricht bearbeitet');
    assert.ok(embed.fields.find(f => f.name === 'Alt' && f.value === 'Original content'));
    assert.ok(embed.fields.find(f => f.name === 'Neu' && f.value === 'Edited content'));
    console.log('   Test 3 passed');
  }

  // Test 4: messageUpdate (no content change)
  {
    console.log('Running Test 4: messageUpdate (no content change)...');
    sendEmbeds = [];

    const oldMessage = {
      guild: mockGuild,
      channel: { id: 'channel_123' },
      author: { id: 'user_123', bot: false },
      content: 'Identical content',
    };

    const newMessage = {
      guild: mockGuild,
      channel: { id: 'channel_123' },
      author: { id: 'user_123', bot: false },
      content: 'Identical content',
    };

    await messageUpdate.execute(oldMessage, newMessage);

    assert.equal(sendEmbeds.length, 0, 'Should not log if content is identical');
    console.log('   Test 4 passed');
  }

  console.log('OK — message_logging smoke-test passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
