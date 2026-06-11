// Smoke-Test für Channel-Hopping Spam-Erkennung in messageCreate.js — kein DB-Zugriff.
// Ausführen mit `node tests/smoke/channel_hopping.js`

const assert = require('node:assert/strict');

// Mock db BEFORE loading anything else
const db = require('../../src/db');
db.getPool = () => {
  return {
    execute: async (sql, params) => {
      // Mock guilds config table fetch
      if (sql.includes('SELECT') && sql.includes('FROM guilds')) {
        return [[{
          mod_log_channel_id: '1509540775535579229',
          toxicity_enabled: 0,
        }]];
      }
      if (sql.includes('INSERT INTO infractions')) {
        return [{ insertId: 123 }];
      }
      return [[]];
    }
  };
};

// Now import target modules
const messageCreate = require('../../src/events/messageCreate');
const cases = require('../../src/cases');

// Override cases.createCase to prevent database insert errors if any
cases.createCase = async (payload) => {
  return { caseNumber: 42 };
};

console.log('==== Channel-Hopping Spam-Erkennung smoke-test ====');

let timedOut = false;
let timeoutDuration = 0;
let deletedMessagesCount = 0;
let modLogSent = false;

const mockChannel1 = { id: 'chan_1', name: 'general' };
const mockChannel2 = { id: 'chan_2', name: 'memes' };
const mockChannel3 = { id: 'chan_3', name: 'gaming' };

const mockMember = {
  permissions: {
    has: () => false // not admin
  },
  timeout: async (duration, reason) => {
    timedOut = true;
    timeoutDuration = duration;
  }
};

const mockModLogChannel = {
  id: '1509540775535579229',
  send: async (payload) => {
    modLogSent = true;
    return {};
  }
};

const mockGuild = {
  id: 'guild_123',
  members: {
    fetch: async () => mockMember
  },
  channels: {
    fetch: async (id) => {
      if (id === '1509540775535579229') return mockModLogChannel;
      return null;
    }
  }
};

const mockClient = {
  user: { id: 'bot_id' },
  channels: {
    fetch: async () => mockModLogChannel
  }
};

function createMockMessage(channel, userId) {
  let isDeleted = false;
  return {
    id: `msg_${Math.random()}`,
    content: 'Spam message',
    author: {
      id: userId,
      bot: false,
      displayAvatarURL: () => 'https://example.com/avatar.png',
      username: `user_${userId}`
    },
    member: {
      ...mockMember,
      id: userId
    },
    guild: mockGuild,
    client: mockClient,
    channel: channel,
    delete: async () => {
      isDeleted = true;
      deletedMessagesCount++;
    },
    get deleted() { return isDeleted; }
  };
}

async function runTests() {
  // Test 1: Sending 3 messages in the same channel should not trigger hopping
  {
    console.log('Test 1: 3 messages in same channel...');
    timedOut = false;
    deletedMessagesCount = 0;
    modLogSent = false;

    const m1 = createMockMessage(mockChannel1, 'user1');
    const m2 = createMockMessage(mockChannel1, 'user1');
    const m3 = createMockMessage(mockChannel1, 'user1');

    await messageCreate.execute(m1);
    await messageCreate.execute(m2);
    await messageCreate.execute(m3);

    assert.equal(timedOut, false, 'Should not time out');
    assert.equal(deletedMessagesCount, 0, 'Should not delete messages');
    console.log('   Test 1 passed');
  }

  // Test 2: Sending messages in 3 different channels within 10 seconds should trigger hopping
  {
    console.log('Test 2: 3 messages in 3 different channels...');
    timedOut = false;
    deletedMessagesCount = 0;
    modLogSent = false;

    const m1 = createMockMessage(mockChannel1, 'user2');
    const m2 = createMockMessage(mockChannel2, 'user2');
    const m3 = createMockMessage(mockChannel3, 'user2');

    // Execute first two
    await messageCreate.execute(m1);
    await messageCreate.execute(m2);
    assert.equal(timedOut, false, 'Should not time out yet');

    // Execute third (in third unique channel)
    await messageCreate.execute(m3);
    assert.equal(timedOut, true, 'Should trigger timeout');
    assert.equal(timeoutDuration, 24 * 60 * 60 * 1000, 'Should be 24 hours');
    assert.equal(deletedMessagesCount, 3, 'Should delete all 3 messages');
    assert.equal(modLogSent, true, 'Should log to mod-log');
    console.log('   Test 2 passed');
  }

  console.log('🎉 Alle Channel-Hopping Smoke-Tests erfolgreich bestanden!');
}

runTests().catch(err => {
  console.error('FAIL', err);
  process.exit(1);
});
