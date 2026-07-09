const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');

// Mock DB pool before loading config/events to run without a live database
const db = require('../../src/db');

let currentGuildRow = {
  join_role_id: null,
  join_role_ids: '1509541112223334111,1509541112223334222',
  captcha_enabled: 0,
  verified_role_id: null,
  verified_role_ids: '1509541112223334333,1509541112223334444',
  unverified_role_ids: '1509541112223334555',
  mod_log_channel_id: '1509540775535579229',
  log_join_leave_enabled: 0,
  welcome_enabled: 0,
};

const mockPool = {
  execute: async (sql, params) => {
    if (sql.toLowerCase().includes('select')) {
      return [[currentGuildRow]];
    }
    return [[]];
  },
  query: async (sql, params) => {
    return [[]];
  }
};
db.getPool = () => mockPool;

const config = require('../../src/config');
const guildMemberAdd = require('../../src/events/guildMemberAdd');
const captcha = require('../../src/interactions/captcha');

const GUILD_ID = '1509528553933242550';
const JOIN_ROLE_1 = '1509541112223334111';
const JOIN_ROLE_2 = '1509541112223334222';
const VERIFIED_ROLE_1 = '1509541112223334333';
const VERIFIED_ROLE_2 = '1509541112223334444';
const UNVERIFIED_ROLE = '1509541112223334555';

async function main() {
  console.log('==== Join Role & Unverified Role Smoke-Test ====');

  // Verify custom config getters/setters first
  assert.deepEqual(await config.getJoinRoleIds(GUILD_ID), [JOIN_ROLE_1, JOIN_ROLE_2]);
  assert.deepEqual(await config.getVerifiedRoleIds(GUILD_ID), [VERIFIED_ROLE_1, VERIFIED_ROLE_2]);
  assert.deepEqual(await config.getUnverifiedRoleIds(GUILD_ID), [UNVERIFIED_ROLE]);
  
  // Test addJoinRoleId
  let lastUpdateParams = [];
  mockPool.execute = async (sql, params) => {
    if (sql.includes('UPDATE guilds SET join_role_ids')) {
      lastUpdateParams = params;
    }
    return [[currentGuildRow]];
  };
  await config.addJoinRoleId(GUILD_ID, '999999');
  assert.deepEqual(lastUpdateParams, [[JOIN_ROLE_1, JOIN_ROLE_2, '999999'].join(','), GUILD_ID]);
  console.log('✓ Config getters/setters and list helpers verified');

  // Restore mockPool behavior
  mockPool.execute = async (sql, params) => {
    return [[currentGuildRow]];
  };

  // Mocks for interaction and member
  let assignedRoles = [];
  let removedRoles = [];
  let sentEmbeds = [];
  let currentMemberRoles = [];

  const mockChannel = {
    id: '1509540775535579229',
    name: 'mod-log',
    send: async (payload) => {
      sentEmbeds.push(...(payload.embeds || []));
      return { id: 'msg_999', delete: async () => {} };
    },
    delete: async (reason) => {}
  };

  const mockMember = {
    id: '1509540000000000001',
    user: { id: '1509540000000000001', tag: 'testuser#1111', displayAvatarURL: () => 'https://example.com', createdAt: new Date() },
    guild: {
      id: GUILD_ID,
      roles: {
        everyone: { id: GUILD_ID },
        cache: {
          get: (id) => ({ id, name: 'Role' }),
          // Mute-rejoin path (getMutedRole) falls back to roles.cache.find() when no
          // muted_role_id is configured — without this the fallback throws a TypeError
          // that guildMemberAdd's mute-rejoin try/catch swallows, but still logs noisily.
          find: () => undefined
        },
        fetch: async (id) => ({ id, name: 'Role' })
      }
    },
    roles: {
      cache: {
        has: (id) => currentMemberRoles.includes(id)
      },
      add: async (role, reason) => {
        const rId = typeof role === 'string' ? role : role.id;
        assignedRoles.push({ roleId: rId, reason });
        currentMemberRoles.push(rId);
      },
      remove: async (role, reason) => {
        const rId = typeof role === 'string' ? role : role.id;
        removedRoles.push({ roleId: rId, reason });
        currentMemberRoles = currentMemberRoles.filter(id => id !== rId);
      }
    },
    // Shared verify channel welcome DM (guildMemberAdd.js) — real GuildMembers always
    // have `.send`, this stub just keeps the mock complete.
    send: async () => {}
  };

  const mockGuild = {
    id: GUILD_ID,
    name: 'Test Guild',
    roles: {
      cache: {
        get: (id) => ({ id, name: 'Role' }),
        find: () => undefined
      },
      fetch: async (id) => ({ id, name: 'Role' })
    },
    members: {
      fetch: async (id) => mockMember,
      me: { id: 'bot_id' }
    },
    channels: {
      fetch: async (id) => mockChannel
    }
  };

  // Test 1: Immediate multiple join role assignment when captcha is disabled
  {
    console.log('Running Test 1: Immediate multiple join roles assignment (Captcha disabled)...');
    assignedRoles = [];
    currentMemberRoles = [];
    currentGuildRow.captcha_enabled = 0;

    // Trigger join event handler
    await guildMemberAdd.execute(mockMember);

    // Assert that both join roles were assigned immediately
    assert.equal(assignedRoles.length, 2);
    assert.equal(assignedRoles[0].roleId, JOIN_ROLE_1);
    assert.equal(assignedRoles[1].roleId, JOIN_ROLE_2);
    assert.equal(assignedRoles[0].reason, 'Oreo: Join-Rolle automatisch zugewiesen');
    console.log('   Test 1 passed');
  }

  // Test 2: Delayed multiple verified and join roles, and unverified role removal when captcha is enabled
  {
    console.log('Running Test 2: Multiple roles assignment and removal (Captcha enabled)...');
    assignedRoles = [];
    removedRoles = [];
    currentMemberRoles = [UNVERIFIED_ROLE]; // user starts with unverified role
    currentGuildRow.captcha_enabled = 1;

    // Mock channels.create
    mockMember.guild.channels = {
      create: async () => mockChannel
    };
    mockMember.client = {
      user: { id: 'bot_id' }
    };
    // getOrCreateSharedVerifyChannel(guild) reads guild.client.user.id (not member.client),
    // since it only ever receives the guild, never the member.
    mockMember.guild.client = mockMember.client;
    
    await guildMemberAdd.execute(mockMember);

    // Assert that the join roles are assigned immediately upon join, but no roles removed yet
    assert.equal(assignedRoles.length, 2);
    assert.equal(assignedRoles[0].roleId, JOIN_ROLE_1);
    assert.equal(assignedRoles[1].roleId, JOIN_ROLE_2);
    assert.equal(removedRoles.length, 0);

    // Now trigger correct Captcha interaction (simulating verification success).
    // Seed the server-side puzzle state directly — the answer no longer lives in the customId.
    captcha._internal.pendingPuzzles.set(`${GUILD_ID}:1509540000000000001`, {
      correctEmoji: '🍎',
      options: ['🍎', '🍌', '🍇', '🍍', '🍒'],
      attempt: 1,
      expiresAt: Date.now() + 60_000,
    });
    const mockInteraction = {
      customId: `captcha_pick_1509540000000000001_0`,
      user: { id: '1509540000000000001' },
      guild: mockGuild,
      channel: mockChannel,
      deferUpdate: async () => {},
      reply: async () => {}
    };

    const handled = await captcha.dispatch(mockInteraction);
    assert.ok(handled, 'Captcha dispatch should handle interaction');

    // Wait for the async verified/join role assignments
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Assert verified roles assigned (2 roles: VERIFIED_ROLE_1, VERIFIED_ROLE_2)
    assert.equal(assignedRoles.filter(r => r.reason.includes('lösen') || r.reason.includes('gelöst')).length, 2);
    assert.ok(assignedRoles.some(r => r.roleId === VERIFIED_ROLE_1));
    assert.ok(assignedRoles.some(r => r.roleId === VERIFIED_ROLE_2));

    // Assert unverified role removed (1 role: UNVERIFIED_ROLE)
    assert.equal(removedRoles.length, 1);
    assert.equal(removedRoles[0].roleId, UNVERIFIED_ROLE);
    assert.equal(removedRoles[0].reason, 'Oreo: Captcha erfolgreich gelöst (Unverified entfernt)');

    // Assert join roles assigned (total of 4 assignments: 2 on join, 2 on captcha verify)
    assert.equal(assignedRoles.filter(r => r.reason.includes('Join-Rolle')).length, 4);

    console.log('   Test 2 passed');
  }

  // Test 3: Unverified role is also a join role
  {
    console.log('Running Test 3: Unverified role is also in join roles...');
    assignedRoles = [];
    removedRoles = [];
    currentMemberRoles = [UNVERIFIED_ROLE]; // user starts with unverified role
    currentGuildRow.captcha_enabled = 1;
    currentGuildRow.join_role_ids = `${JOIN_ROLE_1},${UNVERIFIED_ROLE}`; // UNVERIFIED_ROLE is also in join roles
    currentGuildRow.unverified_role_ids = UNVERIFIED_ROLE;

    // Trigger join
    await guildMemberAdd.execute(mockMember);

    // Now trigger correct Captcha interaction
    captcha._internal.pendingPuzzles.set(`${GUILD_ID}:1509540000000000001`, {
      correctEmoji: '🍎',
      options: ['🍎', '🍌', '🍇', '🍍', '🍒'],
      attempt: 1,
      expiresAt: Date.now() + 60_000,
    });
    const mockInteraction = {
      customId: `captcha_pick_1509540000000000001_0`,
      user: { id: '1509540000000000001' },
      guild: mockGuild,
      channel: mockChannel,
      deferUpdate: async () => {},
      reply: async () => {}
    };

    await captcha.dispatch(mockInteraction);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify unverified role is removed
    assert.equal(removedRoles.length, 1);
    assert.equal(removedRoles[0].roleId, UNVERIFIED_ROLE);

    // Verify that UNVERIFIED_ROLE is NOT added back during verification step (only JOIN_ROLE_1 is added)
    const joinRolesAfterVerify = assignedRoles.filter(r => r.reason.includes('nach Captcha-Verifizierung'));
    assert.equal(joinRolesAfterVerify.length, 1);
    assert.equal(joinRolesAfterVerify[0].roleId, JOIN_ROLE_1);

    console.log('   Test 3 passed');
  }

  console.log('🎉 All multiple roles & removal smoke-tests passed successfully!');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
