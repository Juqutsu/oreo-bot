// Smoke-Test für src/modlog.js — kein DB-Zugriff, kein Discord-Client.
// Konvention: ausführen mit `node tests/smoke/modlog.js` (keine --env-file nötig).

const assert = require('node:assert/strict');
const { buildModLogEmbed } = require('../../src/modlog');

console.log('==== src/modlog.js smoke-test ====');

const stubUser = (id, name) => ({
  id,
  username: name,
  displayAvatarURL: () => `https://cdn.discord.example/${id}.png`,
});

const target = stubUser('111', 'TargetUser');
const mod = stubUser('222', 'ModUser');

// 1. action=warn, mit caseNumber
{
  const embed = buildModLogEmbed({
    action: 'warn',
    caseNumber: 7,
    target,
    mod,
    reason: 'Spam',
  });
  const data = embed.toJSON();
  assert.equal(data.title, '⚠️ User verwarnt');
  assert.equal(data.color, 0xfaa61a);
  assert.equal(data.fields.length, 3, 'warn: 3 fields ohne dmFailed');
  assert.equal(data.fields[0].name, '👤 User');
  assert.equal(data.fields[0].value, '<@111>');
  assert.equal(data.fields[1].name, '🛡️ Moderator');
  assert.equal(data.fields[2].name, '📝 Grund');
  assert.equal(data.fields[2].value, 'Spam');
  assert.equal(data.footer.text, 'Case #7 · 🐾');
  assert.ok(data.timestamp, 'timestamp gesetzt');
  console.log('✓ action=warn (no dmFailed)');
}

// 2. action=warn, dmFailed=true
{
  const embed = buildModLogEmbed({
    action: 'warn',
    caseNumber: 7,
    target,
    mod,
    reason: 'Spam',
    dmFailed: true,
  });
  const data = embed.toJSON();
  assert.equal(data.fields.length, 4, 'warn: 4 fields mit dmFailed');
  assert.equal(data.fields[3].name, '📬 DM');
  assert.equal(data.fields[3].value, 'Nicht zugestellt (DMs aus?)');
  console.log('✓ action=warn (dmFailed=true)');
}

// 3. action=timeout
{
  const embed = buildModLogEmbed({
    action: 'timeout',
    caseNumber: 8,
    target,
    mod,
    reason: 'Trolling',
    durationMs: 60000,
  });
  const data = embed.toJSON();
  assert.equal(data.title, '⏱️ Timeout vergeben');
  assert.equal(data.color, 0xfaa61a);
  assert.equal(data.fields.length, 5);
  assert.equal(data.fields[0].name, 'User');
  assert.equal(data.fields[0].value, '<@111>', 'kein (username)-Suffix mehr');
  assert.equal(data.fields[0].inline, true);
  assert.equal(data.fields[1].name, 'Moderator');
  assert.equal(data.fields[1].value, '<@222>');
  assert.equal(data.fields[2].name, 'Grund');
  assert.equal(data.fields[3].name, 'Dauer');
  assert.equal(data.fields[4].name, 'Läuft ab');
  console.log('✓ action=timeout');
}

// 4. action=kick
{
  const embed = buildModLogEmbed({
    action: 'kick',
    caseNumber: 9,
    target, mod, reason: 'Regelbruch',
  });
  const data = embed.toJSON();
  assert.equal(data.title, 'User gekickt');
  assert.equal(data.color, 0xed4245);
  assert.equal(data.fields.length, 3);
  console.log('✓ action=kick');
}

// 5. action=ban
{
  const embed = buildModLogEmbed({
    action: 'ban',
    caseNumber: 10,
    target, mod, reason: 'NSFW',
  });
  const data = embed.toJSON();
  assert.equal(data.title, '🔨 User gebannt');
  assert.equal(data.color, 0xed4245);
  console.log('✓ action=ban');
}

// 6. action=unknown → null
{
  const result = buildModLogEmbed({
    action: 'mystery', caseNumber: 1, target, mod, reason: '',
  });
  assert.equal(result, null, 'unbekannte action → null');
  console.log('✓ action=unknown → null');
}

// 7. caseNumber=null → fallback footer
{
  const embed = buildModLogEmbed({
    action: 'warn', caseNumber: null, target, mod, reason: 'x',
  });
  const data = embed.toJSON();
  assert.equal(data.footer.text, 'Case-Eintrag fehlgeschlagen · 🐾');
  console.log('✓ caseNumber=null → fallback footer');
}

// 8. reason=null → "Kein Grund angegeben"
{
  const embed = buildModLogEmbed({
    action: 'warn', caseNumber: 1, target, mod, reason: null,
  });
  const data = embed.toJSON();
  assert.equal(data.fields[2].value, 'Kein Grund angegeben');
  console.log('✓ reason=null → fallback text');
}

console.log('✓ alle modlog-smoke-tests passed');
