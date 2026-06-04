// Smoke test for src/events/guildAuditLogEntryCreate.js
// Run with: node --env-file=.env tests/smoke/audit_mirror.js

const assert = require('node:assert/strict');
const { AuditLogEvent } = require('discord.js');
const eventHandler = require('../../src/events/guildAuditLogEntryCreate');
const { getPool } = require('../../src/db');

const GUILD_ID = '1509528553933242550';
const TARGET_ID = '414500515158949890';
const MOD_ID = '820239667873316874';

async function main() {
  console.log('==== src/events/guildAuditLogEntryCreate.js smoke-test ====');

  const pool = getPool();

  // Ensure guild row exists (FK constraint)
  await pool.query(
    `INSERT INTO guilds (guild_id, next_case_number)
       VALUES (?, 1) ON DUPLICATE KEY UPDATE guild_id = guild_id`,
    [GUILD_ID]
  );

  // Setup mock channels and clients
  let sendEmbeds = [];
  const mockChannel = {
    send: async (payload) => {
      sendEmbeds.push(...payload.embeds);
    }
  };

  const mockClient = {
    user: { id: 'bot_id_123456789' },
    users: {
      fetch: async (id) => {
        return {
          id,
          username: id === TARGET_ID ? 'TargetUser' : 'ModUser',
          displayAvatarURL: () => 'https://cdn.discord.example/avatar.png',
        };
      }
    }
  };

  const mockGuild = {
    id: GUILD_ID,
    client: mockClient,
    channels: {
      fetch: async (id) => {
        return mockChannel;
      }
    }
  };

  // Helper to fetch the last created case
  const getLastCase = async () => {
    const [rows] = await pool.query(
      'SELECT * FROM infractions WHERE guild_id = ? ORDER BY id DESC LIMIT 1',
      [GUILD_ID]
    );
    return rows[0] ?? null;
  };

  // Helper to get initial case count
  const getCaseCount = async () => {
    const [[row]] = await pool.query('SELECT COUNT(*) AS count FROM infractions WHERE guild_id = ?', [GUILD_ID]);
    return Number(row.count);
  };

  // Test 1: Ignore actions performed by the bot itself
  {
    console.log('Running Test 1: Ignore bot self-actions...');
    const initialCount = await getCaseCount();
    sendEmbeds = [];

    const entry = {
      id: '9990001',
      action: AuditLogEvent.MemberBanAdd,
      executorId: 'bot_id_123456789', // Matches bot user id
      targetId: TARGET_ID,
      reason: 'Self-executed ban',
      createdAt: new Date(),
    };

    await eventHandler.execute(entry, mockGuild);

    const finalCount = await getCaseCount();
    assert.equal(finalCount, initialCount, 'Self-action should not create a case');
    assert.equal(sendEmbeds.length, 0, 'Self-action should not post mod-log');
    console.log('✓ Test 1 passed');
  }

  // Test 2: UI Ban triggers case & embed
  {
    console.log('Running Test 2: UI Ban...');
    const initialCount = await getCaseCount();
    sendEmbeds = [];

    const entry = {
      id: '9990002',
      action: AuditLogEvent.MemberBanAdd,
      executorId: MOD_ID,
      targetId: TARGET_ID,
      reason: 'Spam via UI',
      createdAt: new Date(),
    };

    await eventHandler.execute(entry, mockGuild);

    const finalCount = await getCaseCount();
    assert.equal(finalCount, initialCount + 1, 'UI Ban should create a case');
    assert.equal(sendEmbeds.length, 1, 'UI Ban should post mod-log');
    
    const embed = sendEmbeds[0].toJSON();
    assert.equal(embed.title, '🔨 User gebannt');
    
    const c = await getLastCase();
    assert.equal(c.type, 'ban');
    assert.equal(c.reason, 'Spam via UI');
    assert.equal(c.source, 'manual');
    assert.equal(c.active, 1);
    console.log('✓ Test 2 passed');
  }

  // Test 3: UI Unban triggers case & embed
  {
    console.log('Running Test 3: UI Unban...');
    const initialCount = await getCaseCount();
    sendEmbeds = [];

    const entry = {
      id: '9990003',
      action: AuditLogEvent.MemberBanRemove,
      executorId: MOD_ID,
      targetId: TARGET_ID,
      reason: 'Pardon via UI',
      createdAt: new Date(),
    };

    await eventHandler.execute(entry, mockGuild);

    const finalCount = await getCaseCount();
    assert.equal(finalCount, initialCount + 1, 'UI Unban should create a case');
    assert.equal(sendEmbeds.length, 1);
    
    const embed = sendEmbeds[0].toJSON();
    assert.equal(embed.title, '🔓 User entbannt');
    
    const c = await getLastCase();
    assert.equal(c.type, 'unban');
    assert.equal(c.reason, 'Pardon via UI');
    console.log('✓ Test 3 passed');
  }

  // Test 4: UI Kick triggers case & embed
  {
    console.log('Running Test 4: UI Kick...');
    const initialCount = await getCaseCount();
    sendEmbeds = [];

    const entry = {
      id: '9990004',
      action: AuditLogEvent.MemberKick,
      executorId: MOD_ID,
      targetId: TARGET_ID,
      reason: 'Kick via UI',
      createdAt: new Date(),
    };

    await eventHandler.execute(entry, mockGuild);

    const finalCount = await getCaseCount();
    assert.equal(finalCount, initialCount + 1, 'UI Kick should create a case');
    assert.equal(sendEmbeds.length, 1);
    
    const embed = sendEmbeds[0].toJSON();
    assert.equal(embed.title, 'User gekickt');
    
    const c = await getLastCase();
    assert.equal(c.type, 'kick');
    assert.equal(c.reason, 'Kick via UI');
    console.log('✓ Test 4 passed');
  }

  // Test 5: UI Timeout triggers case & embed
  {
    console.log('Running Test 5: UI Timeout...');
    const initialCount = await getCaseCount();
    sendEmbeds = [];

    const now = new Date();
    // Timeout of 1 hour (3600000 ms)
    const timeoutExpiry = new Date(now.getTime() + 3600000);

    const entry = {
      id: '9990005',
      action: AuditLogEvent.MemberUpdate,
      executorId: MOD_ID,
      targetId: TARGET_ID,
      reason: 'Timeout via UI',
      createdAt: now,
      changes: [
        {
          key: 'communication_disabled_until',
          new: timeoutExpiry.toISOString(),
        }
      ]
    };

    await eventHandler.execute(entry, mockGuild);

    const finalCount = await getCaseCount();
    assert.equal(finalCount, initialCount + 1, 'UI Timeout should create a case');
    assert.equal(sendEmbeds.length, 1);
    
    const embed = sendEmbeds[0].toJSON();
    assert.equal(embed.title, '⏱️ Timeout vergeben');
    
    const c = await getLastCase();
    assert.equal(c.type, 'timeout');
    assert.equal(c.reason, 'Timeout via UI');
    // Check duration is approximately 3600000 ms (allowing slight timing variance)
    assert.ok(Math.abs(Number(c.duration_ms) - 3600000) < 1000);
    console.log('✓ Test 5 passed');
  }

  // Test 6: UI Untimeout triggers case & embed
  {
    console.log('Running Test 6: UI Untimeout...');
    const initialCount = await getCaseCount();
    sendEmbeds = [];

    const entry = {
      id: '9990006',
      action: AuditLogEvent.MemberUpdate,
      executorId: MOD_ID,
      targetId: TARGET_ID,
      reason: 'Untimeout via UI',
      createdAt: new Date(),
      changes: [
        {
          key: 'communication_disabled_until',
          new: null,
        }
      ]
    };

    await eventHandler.execute(entry, mockGuild);

    const finalCount = await getCaseCount();
    assert.equal(finalCount, initialCount + 1, 'UI Untimeout should create a case');
    assert.equal(sendEmbeds.length, 1);
    
    const embed = sendEmbeds[0].toJSON();
    assert.equal(embed.title, '🔊 Timeout aufgehoben');
    
    const c = await getLastCase();
    assert.equal(c.type, 'untimeout');
    assert.equal(c.reason, 'Untimeout via UI');
    console.log('✓ Test 6 passed');
  }

  console.log('OK — audit_mirror smoke-test passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
