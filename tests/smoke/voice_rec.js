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
const voiceConfirm = require('../../src/interactions/voiceconfirm');

async function main() {
  console.log('==== Voice Recognition / Speech Event Smoke-Test ====');

  let sentMessages = [];
  const mockTextChannel = {
    name: 'team-chat',
    send: async (text) => {
      sentMessages.push(text);
    }
  };

  const OWNER_ID = 'owner-user-id';

  const mockGuild = {
    id: '1509528553933242550',
    ownerId: OWNER_ID,
    channels: {
      fetch: async (id) => {
        assert.equal(id, '1509540775535579229');
        return mockTextChannel;
      }
    },
    // Staff-Check (perms.hasTier) für den Aufrufer greift über den Server-Owner-Bypass,
    // damit die Bestätigungs-Tests keine role_permissions-DB-Fixture brauchen.
    members: {
      fetch: async (id) => ({ id, guild: mockGuild, roles: { cache: new Map() } }),
    },
  };

  const mockVoiceChannel = {
    id: 'voice-channel-1',
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

  // Test Case 5: Wortbasiertes Matching — "oreo banane" ist KEIN Ban-Befehl mehr
  // (früher: Substring-Match auf "ban" hätte hier fälschlich ausgelöst).
  {
    sentMessages = [];
    mockConfigRow.voice_rec_enabled = 1;
    const msg = {
      content: 'Oreo Banane schmeckt gut',
      author: { tag: 'Lukas#0001' },
      channel: mockVoiceChannel
    };

    await speechEvent.execute(msg);

    assert.equal(sentMessages.length, 0, '"oreo banane" darf keinen Ban-Befehl auslösen');
    console.log('✓ Test Case 5 passed (word-boundary: "oreo banane" does NOT trigger ban)');
  }

  // Test Case 6: Lockdown ist jetzt destruktiv → Button-Bestätigung statt direkter Aktion.
  {
    sentMessages = [];
    voiceConfirm._internal.pending.clear();
    mockConfigRow.voice_rec_enabled = 1;
    const msg = {
      content: 'Oreo Lockdown',
      author: { id: OWNER_ID, tag: 'Owner#0001' },
      channel: mockVoiceChannel
    };

    await speechEvent.execute(msg);

    assert.equal(sentMessages.length, 1, 'lockdown posts exactly one confirmation prompt');
    const posted = sentMessages[0];
    assert.ok(posted.content.includes('Bestätige innerhalb von 60 Sekunden'), 'prompt asks for confirmation');
    assert.equal(posted.components.length, 1, 'prompt has one button row');
    assert.equal(voiceConfirm._internal.pending.size, 1, 'lockdown request is pending confirmation');
    const [entry] = voiceConfirm._internal.pending.values();
    assert.equal(entry.action, 'lockdown');
    voiceConfirm._internal.pending.clear();
    console.log('✓ Test Case 6 passed (lockdown requires button confirmation, no direct mute)');
  }

  // Test Case 7: Voice-Mute ist jetzt destruktiv → Button-Bestätigung statt direktem Timeout.
  {
    sentMessages = [];
    voiceConfirm._internal.pending.clear();
    mockConfigRow.voice_rec_enabled = 1;

    let timeoutCalled = false;
    const targetMember = {
      id: 'target-user-id',
      displayName: 'Ziel',
      guild: mockGuild,
      roles: { cache: new Map() },
      user: { username: 'zieluser', bot: false },
      timeout: async () => { timeoutCalled = true; },
      voice: { setMute: async () => {} },
    };
    const voiceChannelWithMembers = {
      ...mockVoiceChannel,
      members: new Map([[targetMember.id, targetMember]]),
    };

    const msg = {
      content: 'Oreo mute Ziel',
      author: { id: OWNER_ID, tag: 'Owner#0001' },
      channel: voiceChannelWithMembers
    };

    await speechEvent.execute(msg);

    assert.equal(timeoutCalled, false, 'target must NOT be timed out before confirmation');
    assert.equal(sentMessages.length, 1, 'mute posts exactly one confirmation prompt');
    assert.ok(sentMessages[0].content.includes('5-Minuten-Timeout'), 'prompt mentions the pending timeout');
    assert.equal(voiceConfirm._internal.pending.size, 1, 'mute request is pending confirmation');
    const [entry] = voiceConfirm._internal.pending.values();
    assert.equal(entry.action, 'mute');
    assert.equal(entry.targetId, 'target-user-id');
    voiceConfirm._internal.pending.clear();
    console.log('✓ Test Case 7 passed (voice-mute requires button confirmation, no direct timeout)');
  }

  console.log('🎉 Alle Voice Recognition Smoke-Tests erfolgreich bestanden!');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
