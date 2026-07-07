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

// Override cases.createCase to prevent database insert errors, and to let tests observe
// whether a (phantom) case would have been created.
let createCaseCalls = 0;
cases.createCase = async (payload) => {
  createCaseCalls++;
  return { caseNumber: 42 };
};

console.log('==== Channel-Hopping Spam-Erkennung smoke-test ====');

let timedOut = false;
let timeoutDuration = 0;
let deletedMessageIds = [];
let embedsSent = 0;
let warningsSent = 0;

// Registry of channels keyed by id, each tracking its own `messages.delete` calls —
// mirrors the real client.channels.fetch(channelId) + channel.messages.delete(messageId)
// resolution path the implementation now uses instead of holding onto Message objects.
const channelRegistry = new Map();

function makeChannel(id, name) {
  const channel = {
    id,
    name,
    messages: {
      delete: async (messageId) => {
        deletedMessageIds.push(messageId);
      },
    },
  };
  channelRegistry.set(id, channel);
  return channel;
}

const mockChannel1 = makeChannel('chan_1', 'general');
const mockChannel2 = makeChannel('chan_2', 'memes');
const mockChannel3 = makeChannel('chan_3', 'gaming');
const mockChannel4 = makeChannel('chan_4', 'other-guild-a');
const mockChannel5 = makeChannel('chan_5', 'other-guild-b');

const mockModLogChannel = {
  id: '1509540775535579229',
  send: async (payload) => {
    if (payload && payload.embeds) {
      embedsSent++;
    } else {
      warningsSent++;
    }
    return {};
  },
};
channelRegistry.set(mockModLogChannel.id, mockModLogChannel);

function makeMember({ throwOnTimeout = false } = {}) {
  return {
    permissions: {
      has: () => false, // not admin
    },
    timeout: async (duration, reason) => {
      if (throwOnTimeout) {
        throw new Error('Missing Permissions');
      }
      timedOut = true;
      timeoutDuration = duration;
    },
  };
}

const mockMember = makeMember();
const mockMemberThatFailsTimeout = makeMember({ throwOnTimeout: true });

function makeGuild(id) {
  return {
    id,
    members: {
      fetch: async () => mockMember,
    },
    channels: {
      fetch: async (channelId) => channelRegistry.get(channelId) ?? null,
    },
  };
}

const mockGuild = makeGuild('guild_123');
const mockGuildOther = makeGuild('guild_456');

const mockClient = {
  user: { id: 'bot_id' },
  channels: {
    fetch: async (channelId) => channelRegistry.get(channelId) ?? null,
  },
};

function createMockMessage(guild, channel, userId, { member } = {}) {
  return {
    id: `msg_${Math.random()}`,
    content: 'Spam message',
    author: {
      id: userId,
      bot: false,
      displayAvatarURL: () => 'https://example.com/avatar.png',
      username: `user_${userId}`,
    },
    member: member ?? { ...mockMember, id: userId },
    guild,
    client: mockClient,
    channel,
  };
}

async function runTests() {
  // Test 1: Sending 3 messages in the same channel should not trigger hopping
  {
    console.log('Test 1: 3 messages in same channel...');
    timedOut = false;
    deletedMessageIds = [];
    embedsSent = 0;
    warningsSent = 0;
    createCaseCalls = 0;

    const m1 = createMockMessage(mockGuild, mockChannel1, 'user1');
    const m2 = createMockMessage(mockGuild, mockChannel1, 'user1');
    const m3 = createMockMessage(mockGuild, mockChannel1, 'user1');

    await messageCreate.execute(m1);
    await messageCreate.execute(m2);
    await messageCreate.execute(m3);

    assert.equal(timedOut, false, 'Should not time out');
    assert.equal(deletedMessageIds.length, 0, 'Should not delete messages');
    assert.equal(createCaseCalls, 0, 'Should not create a case');
    console.log('   Test 1 passed');
  }

  // Test 2: Sending messages in 3 different channels within 10 seconds should trigger hopping
  {
    console.log('Test 2: 3 messages in 3 different channels...');
    timedOut = false;
    deletedMessageIds = [];
    embedsSent = 0;
    warningsSent = 0;
    createCaseCalls = 0;

    const m1 = createMockMessage(mockGuild, mockChannel1, 'user2');
    const m2 = createMockMessage(mockGuild, mockChannel2, 'user2');
    const m3 = createMockMessage(mockGuild, mockChannel3, 'user2');

    // Execute first two
    await messageCreate.execute(m1);
    await messageCreate.execute(m2);
    assert.equal(timedOut, false, 'Should not time out yet');

    // Execute third (in third unique channel)
    await messageCreate.execute(m3);
    assert.equal(timedOut, true, 'Should trigger timeout');
    assert.equal(timeoutDuration, 24 * 60 * 60 * 1000, 'Should be 24 hours');
    assert.deepEqual(
      deletedMessageIds.sort(),
      [m1.id, m2.id, m3.id].sort(),
      'Should delete all 3 messages by their stored ids, resolved via channel.messages.delete'
    );
    assert.equal(createCaseCalls, 1, 'Should create exactly one timeout case');
    assert.equal(embedsSent, 1, 'Should log the success embed to mod-log');
    assert.equal(warningsSent, 0, 'Should not post a failure warning');
    console.log('   Test 2 passed');
  }

  // Test 3: Guild-scoping — the same userId hopping across DIFFERENT guilds must never
  // combine into one false trigger (map is keyed by `${guildId}:${userId}`, not bare userId).
  {
    console.log('Test 3: Same user, different guilds, does not cross-contaminate...');
    timedOut = false;
    deletedMessageIds = [];
    embedsSent = 0;
    warningsSent = 0;
    createCaseCalls = 0;

    const a1 = createMockMessage(mockGuild, mockChannel1, 'user3');
    const a2 = createMockMessage(mockGuild, mockChannel2, 'user3');
    // Two unique channels visited in guild_123 — one below the limit, no trigger yet.
    await messageCreate.execute(a1);
    await messageCreate.execute(a2);
    assert.equal(timedOut, false, 'Should not time out after 2 unique channels in guild A');

    // Same user, but a message in an UNRELATED guild. With a bare-userId key this would be
    // the 3rd unique channel and would wrongly trigger a 24h timeout in guild B.
    const b1 = createMockMessage(mockGuildOther, mockChannel4, 'user3');
    await messageCreate.execute(b1);

    assert.equal(timedOut, false, 'Cross-guild activity must not combine into one hopping window');
    assert.equal(deletedMessageIds.length, 0, 'No messages should have been deleted');
    assert.equal(createCaseCalls, 0, 'No case should have been created');
    console.log('   Test 3 passed');
  }

  // Test 4: No phantom punishment — if member.timeout() throws, there must be no message
  // deletion, no case, and no success modlog entry; only a console warning + a mod-log
  // failure notice.
  {
    console.log('Test 4: member.timeout() fails -> no phantom punishment...');
    deletedMessageIds = [];
    embedsSent = 0;
    warningsSent = 0;
    createCaseCalls = 0;

    const guildWithFailingTimeout = makeGuild('guild_789');
    guildWithFailingTimeout.members.fetch = async () => mockMemberThatFailsTimeout;

    const f1 = createMockMessage(guildWithFailingTimeout, mockChannel1, 'user4', { member: mockMemberThatFailsTimeout });
    const f2 = createMockMessage(guildWithFailingTimeout, mockChannel2, 'user4', { member: mockMemberThatFailsTimeout });
    const f3 = createMockMessage(guildWithFailingTimeout, mockChannel3, 'user4', { member: mockMemberThatFailsTimeout });

    await messageCreate.execute(f1);
    await messageCreate.execute(f2);
    await messageCreate.execute(f3);

    assert.equal(deletedMessageIds.length, 0, 'Should NOT delete messages when timeout failed');
    assert.equal(createCaseCalls, 0, 'Should NOT create a case when timeout failed');
    assert.equal(embedsSent, 0, 'Should NOT post the success modlog embed when timeout failed');
    assert.equal(warningsSent, 1, 'Should post exactly one plain-text failure warning to mod-log');
    console.log('   Test 4 passed');
  }

  console.log('🎉 Alle Channel-Hopping Smoke-Tests erfolgreich bestanden!');
}

runTests().catch(err => {
  console.error('FAIL', err);
  process.exit(1);
});
