// Run with: node --env-file=.env tests/smoke/voiceconfirm.js  (braucht MySQL, siehe cases.createCase)
const assert = require('node:assert/strict');

const GUILD = '999999999999999950';
const REQUESTER_ID = '999999999999999951';
const TARGET_ID = '999999999999999952';

async function main() {
  const { getPool } = require('../../src/db');
  const voiceConfirm = require('../../src/interactions/voiceconfirm');
  const cases = require('../../src/cases');

  await getPool().execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [GUILD]);
  await getPool().query('DELETE FROM infractions WHERE guild_id = ?', [GUILD]);

  const { pending } = voiceConfirm._internal;

  // ---------- Helpers ----------
  function makeMockChannel(name = 'mod-log') {
    const sent = [];
    return {
      name,
      send: async (payload) => { sent.push(payload); return payload; },
      _sent: sent,
    };
  }

  function makeMockGuild({ voiceChannel, modLogChannel }) {
    return {
      id: GUILD,
      ownerId: 'owner-not-relevant',
      roles: { everyone: 'everyone-role' },
      channels: {
        fetch: async (id) => {
          if (id === voiceChannel.id) return voiceChannel;
          if (modLogChannel && id === modLogChannel.__id) return modLogChannel;
          return null;
        },
      },
      members: {
        fetch: async (id) => (id === TARGET_ID ? voiceChannel.members.get(TARGET_ID) ?? null : null),
      },
    };
  }

  function makeInteraction({ customId, userId, guild, memberRolesEmpty = true }) {
    const updates = [];
    const replies = [];
    return {
      isButton: () => true,
      customId,
      user: { id: userId, tag: `${userId}#0000` },
      member: { id: userId, guild, roles: { cache: memberRolesEmpty ? new Map() : new Map([['x', true]]) } },
      guild,
      update: async (payload) => { updates.push(payload); return payload; },
      reply: async (payload) => { replies.push(payload); return payload; },
      _updates: updates,
      _replies: replies,
    };
  }

  // ---------- Test 1: requestConfirmation stores pending entry + posts prompt ----------
  {
    const textChannel = makeMockChannel('voice-text');
    const voiceChannel = { id: 'vc-1', name: 'Lounge', guild: { id: GUILD } };

    await voiceConfirm.requestConfirmation({
      textChannel,
      voiceChannel,
      requester: { id: REQUESTER_ID },
      action: 'lockdown',
    });

    assert.equal(textChannel._sent.length, 1, 'posts exactly one prompt');
    assert.ok(textChannel._sent[0].content.includes('Bestätige innerhalb von 60 Sekunden'));
    assert.equal(textChannel._sent[0].components.length, 1);
    assert.equal(pending.size, 1, 'one pending entry stored');
    pending.clear();
    console.log('✓ Test 1 passed (requestConfirmation stores pending + posts prompt)');
  }

  // ---------- Test 2: dispatch ignores non-voiceconfirm customIds ----------
  {
    const handled = await voiceConfirm.dispatch({ isButton: () => true, customId: 'captcha_pick_x_0' });
    assert.equal(handled, false, 'non-voiceconfirm customId is not handled');
    console.log('✓ Test 2 passed (dispatch ignores foreign customIds)');
  }

  // ---------- Test 3: expired entry ----------
  {
    pending.set('1', {
      action: 'lockdown',
      guildId: GUILD,
      voiceChannelId: 'vc-1',
      requesterId: REQUESTER_ID,
      targetId: null,
      expiresAt: Date.now() - 1,
    });
    const guild = makeMockGuild({ voiceChannel: { id: 'vc-1', name: 'Lounge', members: new Map() } });
    const interaction = makeInteraction({ customId: 'voiceconfirm:ok:1', userId: REQUESTER_ID, guild });

    const handled = await voiceConfirm.dispatch(interaction);
    assert.equal(handled, true);
    assert.equal(interaction._updates.length, 1);
    assert.ok(interaction._updates[0].content.includes('abgelaufen'));
    assert.equal(pending.has('1'), false, 'expired entry is cleaned up');
    console.log('✓ Test 3 passed (expired confirmation rejected)');
  }

  // ---------- Test 4: wrong user (not requester, not staff) is rejected ----------
  {
    pending.set('2', {
      action: 'lockdown',
      guildId: GUILD,
      voiceChannelId: 'vc-1',
      requesterId: REQUESTER_ID,
      targetId: null,
      expiresAt: Date.now() + 60_000,
    });
    const guild = makeMockGuild({ voiceChannel: { id: 'vc-1', name: 'Lounge', members: new Map() } });
    const interaction = makeInteraction({ customId: 'voiceconfirm:ok:2', userId: 'random-other-user', guild });

    const handled = await voiceConfirm.dispatch(interaction);
    assert.equal(handled, true);
    assert.equal(interaction._replies.length, 1, 'rejects via ephemeral reply, not update');
    assert.ok(interaction._replies[0].content.includes('nicht für dich'));
    assert.equal(pending.has('2'), true, 'pending entry survives an unauthorized click');
    pending.delete('2');
    console.log('✓ Test 4 passed (unauthorized clicker rejected, entry untouched)');
  }

  // ---------- Test 4b: already-claimed entry is not acted on twice (double-click race) ----------
  {
    const voiceChannel = { id: 'vc-1', name: 'Lounge', members: new Map() };
    let overwriteEdited = false;
    voiceChannel.permissionOverwrites = { edit: async () => { overwriteEdited = true; } };
    const guild = makeMockGuild({ voiceChannel });

    pending.set('claimed-1', {
      action: 'lockdown',
      guildId: GUILD,
      voiceChannelId: 'vc-1',
      requesterId: REQUESTER_ID,
      targetId: null,
      expiresAt: Date.now() + 60_000,
      claimed: true, // simulates the first of two near-simultaneous clicks having already claimed it
    });
    const interaction = makeInteraction({ customId: 'voiceconfirm:ok:claimed-1', userId: REQUESTER_ID, guild });

    const handled = await voiceConfirm.dispatch(interaction);
    assert.equal(handled, true);
    assert.equal(interaction._replies.length, 1, 'second click gets an ephemeral reply, not an update');
    assert.ok(interaction._replies[0].content.includes('bereits bearbeitet'));
    assert.equal(overwriteEdited, false, 'the lockdown action itself never ran for the second click');
    assert.equal(pending.has('claimed-1'), true, 'claimed entry is left in place (first click still owns cleanup)');
    pending.delete('claimed-1');
    console.log('✓ Test 4b passed (already-claimed entry rejects a second dispatch without acting)');
  }

  // ---------- Test 5: cancel ("no") clears the pending entry ----------
  {
    pending.set('3', {
      action: 'mute',
      guildId: GUILD,
      voiceChannelId: 'vc-1',
      requesterId: REQUESTER_ID,
      targetId: TARGET_ID,
      expiresAt: Date.now() + 60_000,
    });
    const guild = makeMockGuild({ voiceChannel: { id: 'vc-1', name: 'Lounge', members: new Map() } });
    const interaction = makeInteraction({ customId: 'voiceconfirm:no:3', userId: REQUESTER_ID, guild });

    const handled = await voiceConfirm.dispatch(interaction);
    assert.equal(handled, true);
    assert.ok(interaction._updates[0].content.includes('abgebrochen'));
    assert.equal(pending.has('3'), false);
    console.log('✓ Test 5 passed (cancel clears pending entry, no side effects)');
  }

  // ---------- Test 6: confirmed mute writes a case + posts modlog ----------
  {
    let timeoutReason = null;
    let muteCalled = false;
    const targetMember = {
      id: TARGET_ID,
      user: { id: TARGET_ID, tag: 'Ziel#0001', displayAvatarURL: () => 'https://cdn.discord.example/ziel.png' },
      timeout: async (ms, reason) => { timeoutReason = reason; },
      voice: { setMute: async () => { muteCalled = true; } },
    };
    const voiceChannel = { id: 'vc-1', name: 'Lounge', members: new Map([[TARGET_ID, targetMember]]) };
    const modLogChannel = makeMockChannel('modlog');
    modLogChannel.__id = 'modlog-channel-1';

    const guild = makeMockGuild({ voiceChannel, modLogChannel });
    guild.channels.fetch = async (id) => {
      if (id === voiceChannel.id) return voiceChannel;
      if (id === modLogChannel.__id) return modLogChannel;
      return null;
    };
    guild.members.fetch = async (id) => (id === TARGET_ID ? targetMember : null);

    // Point config's mod-log lookup at our fake channel id (env fallback, no DB row needed).
    const prevModlogEnv = process.env.MODLOG_CHANNEL_ID;
    process.env.MODLOG_CHANNEL_ID = modLogChannel.__id;

    pending.set('4', {
      action: 'mute',
      guildId: GUILD,
      voiceChannelId: voiceChannel.id,
      requesterId: REQUESTER_ID,
      targetId: TARGET_ID,
      expiresAt: Date.now() + 60_000,
    });
    const interaction = makeInteraction({ customId: 'voiceconfirm:ok:4', userId: REQUESTER_ID, guild });

    const handled = await voiceConfirm.dispatch(interaction);
    process.env.MODLOG_CHANNEL_ID = prevModlogEnv;

    assert.equal(handled, true);
    assert.ok(timeoutReason && timeoutReason.includes('bestätigt'), 'timeout applied with confirmed reason');
    assert.equal(muteCalled, true, 'voice.setMute applied');
    assert.equal(pending.has('4'), false);

    const finalUpdate = interaction._updates[0];
    assert.ok(finalUpdate.content.includes('stummgeschaltet'));
    const caseMatch = finalUpdate.content.match(/Case #(\d+)/);
    assert.ok(caseMatch, 'final message references a case number');

    const caseNumber = Number(caseMatch[1]);
    const row = await cases.getCaseByNumber(GUILD, caseNumber);
    assert.ok(row, 'case row was persisted');
    assert.equal(row.type, 'timeout');
    assert.equal(String(row.user_id), TARGET_ID);
    assert.equal(String(row.moderator_id), REQUESTER_ID);
    assert.ok(row.expires_at, 'expires_at was computed DB-side from expiresInMs');

    assert.equal(modLogChannel._sent.length, 1, 'modlog entry was posted');
    console.log('✓ Test 6 passed (confirmed voice-mute writes case + modlog)');
  }

  // ---------- Test 7: confirmed mute when target left the guild ----------
  {
    const voiceChannel = { id: 'vc-1', name: 'Lounge', members: new Map() };
    const guild = makeMockGuild({ voiceChannel });
    guild.members.fetch = async () => null;

    pending.set('5', {
      action: 'mute',
      guildId: GUILD,
      voiceChannelId: voiceChannel.id,
      requesterId: REQUESTER_ID,
      targetId: 'gone-user',
      expiresAt: Date.now() + 60_000,
    });
    const interaction = makeInteraction({ customId: 'voiceconfirm:ok:5', userId: REQUESTER_ID, guild });

    const handled = await voiceConfirm.dispatch(interaction);
    assert.equal(handled, true);
    assert.ok(interaction._updates[0].content.includes('nicht mehr auf dem Server'));
    console.log('✓ Test 7 passed (missing target handled gracefully)');
  }

  // ---------- Test 8: confirmed lockdown mutes non-staff, skips staff ----------
  {
    const STAFF_ROLE_ID = '111111111111111111';
    await getPool().query('DELETE FROM role_permissions WHERE guild_id = ?', [GUILD]);
    await getPool().execute(
      "INSERT INTO role_permissions (guild_id, role_id, permission) VALUES (?, ?, 'supporter')",
      [GUILD, STAFF_ROLE_ID],
    );

    let overwriteEdited = false;
    const voiceChannel = {
      id: 'vc-1',
      name: 'Lounge',
      permissionOverwrites: { edit: async () => { overwriteEdited = true; } },
      members: new Map(),
    };
    const guild = { id: GUILD, roles: { everyone: 'everyone-role' }, channels: { fetch: async (id) => (id === voiceChannel.id ? voiceChannel : null) } };

    const staffMember = {
      id: 'staff-1', guild, user: { bot: false }, roles: { cache: new Map([[STAFF_ROLE_ID, true]]) },
      voice: { setMute: async () => { throw new Error('staff must not be muted'); } },
    };
    let mutedNonStaff = false;
    const nonStaffMember = {
      id: 'nonstaff-1', guild, user: { bot: false }, roles: { cache: new Map() },
      voice: { setMute: async () => { mutedNonStaff = true; } },
    };
    const botMember = {
      id: 'bot-1', guild, user: { bot: true }, roles: { cache: new Map() },
      voice: { setMute: async () => { throw new Error('bots must be skipped'); } },
    };
    voiceChannel.members.set(staffMember.id, staffMember);
    voiceChannel.members.set(nonStaffMember.id, nonStaffMember);
    voiceChannel.members.set(botMember.id, botMember);

    pending.set('6', {
      action: 'lockdown',
      guildId: GUILD,
      voiceChannelId: voiceChannel.id,
      requesterId: REQUESTER_ID,
      targetId: null,
      expiresAt: Date.now() + 60_000,
    });
    const interaction = makeInteraction({ customId: 'voiceconfirm:ok:6', userId: REQUESTER_ID, guild });

    const handled = await voiceConfirm.dispatch(interaction);
    assert.equal(handled, true);
    assert.equal(overwriteEdited, true, 'channel speak-overwrite was set');
    assert.equal(mutedNonStaff, true, 'non-staff member was muted');
    assert.ok(interaction._updates[0].content.includes('1 User gemutet'), 'exactly the one non-staff member counted');
    assert.equal(pending.has('6'), false);

    await getPool().query('DELETE FROM role_permissions WHERE guild_id = ?', [GUILD]);
    console.log('✓ Test 8 passed (confirmed lockdown mutes non-staff only, staff/bots skipped)');
  }

  await getPool().query('DELETE FROM infractions WHERE guild_id = ?', [GUILD]);
  console.log('OK — voiceconfirm dispatch smoke test passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
