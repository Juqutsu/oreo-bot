const assert = require('node:assert/strict');

// Mock DB pool before loading config
const db = require('../../src/db');

let mockConfigRow = {
  voice_rec_enabled: 1,
  voice_rec_channel_id: '1509540775535579229',
  voice_rec_message: 'Triggered Oreo Ban!'
};

const mockPool = {
  execute: async (sql, params) => {
    return [[mockConfigRow]];
  },
  query: async (sql, params) => {
    return [[]];
  }
};
db.getPool = () => mockPool;

const speechEvent = require('../../src/events/speech');

async function main() {
  console.log('==== Voice Recognition / Speech Event Smoke-Test ====');

  let sentMessages = [];
  const mockTextChannel = {
    name: 'team-chat',
    send: async (text) => {
      sentMessages.push(text);
    }
  };

  const mockGuild = {
    id: '1509528553933242550',
    channels: {
      fetch: async (id) => {
        assert.equal(id, '1509540775535579229');
        return mockTextChannel;
      }
    }
  };

  const mockVoiceChannel = {
    name: 'Lounge',
    guild: mockGuild
  };

  // Test Case 1: Trigger works with exact "Oreo Ban"
  {
    sentMessages = [];
    mockConfigRow.voice_rec_enabled = 1;
    const msg = {
      content: 'Oreo Ban',
      author: { tag: 'Lukas#0001' },
      channel: mockVoiceChannel
    };

    await speechEvent.execute(msg);

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0], 'Triggered Oreo Ban!');
    console.log('✓ Test Case 1 passed (exact match)');
  }

  // Test Case 2: Trigger works with variations like "oreo band" and spacing
  {
    sentMessages = [];
    mockConfigRow.voice_rec_enabled = 1;
    const msg = {
      content: '   Oreo   Band  ',
      author: { tag: 'Lukas#0001' },
      channel: mockVoiceChannel
    };

    await speechEvent.execute(msg);

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0], 'Triggered Oreo Ban!');
    console.log('✓ Test Case 2 passed (variations & whitespace)');
  }

  // Test Case 3: Trigger does NOT work with unrelated phrases
  {
    sentMessages = [];
    mockConfigRow.voice_rec_enabled = 1;
    const msg = {
      content: 'Hallo bot, wie geht es dir?',
      author: { tag: 'Lukas#0001' },
      channel: mockVoiceChannel
    };

    await speechEvent.execute(msg);

    assert.equal(sentMessages.length, 0);
    console.log('✓ Test Case 3 passed (unrelated text ignored)');
  }

  // Test Case 4: Trigger does NOT work if voice recognition is disabled
  {
    sentMessages = [];
    mockConfigRow.voice_rec_enabled = 0; // disabled!
    const msg = {
      content: 'Oreo Ban',
      author: { tag: 'Lukas#0001' },
      channel: mockVoiceChannel
    };

    await speechEvent.execute(msg);

    assert.equal(sentMessages.length, 0);
    console.log('✓ Test Case 4 passed (disabled config ignored)');
  }

  console.log('🎉 Alle Voice Recognition Smoke-Tests erfolgreich bestanden!');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
