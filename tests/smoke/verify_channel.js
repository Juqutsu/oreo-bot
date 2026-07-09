// Run with: node tests/smoke/verify_channel.js  (braucht MySQL aus .env)
// Regressionstest für die Raid-DoS-Fixe in src/composables/verifyChannel.js (Invariante 16):
// N gleichzeitige Joins dürfen NIEMALS N channels.create-Aufrufe auslösen.
const assert = require('node:assert/strict');

function tick(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { getOrCreateSharedVerifyChannel } = require('../../src/composables/verifyChannel');
  const config = require('../../src/config');
  const { getPool } = require('../../src/db');
  const G = '999999999999999701';

  await getPool().execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [G]);
  // Raw UPDATE außerhalb der config.js-Setter → Cache manuell invalidieren (siehe Invariante 9).
  await getPool().execute('UPDATE guilds SET captcha_channel_id = NULL WHERE guild_id = ?', [G]);
  config.invalidateGuildRowCache(G);

  // Test 1: 20 gleichzeitige Joins (Raid-Welle) müssen sich EINEN Erstellungs-Promise teilen.
  {
    let createCount = 0;
    let sendCount = 0;
    // captcha_channel_id ist BIGINT in der DB — die Mock-Channel-ID muss numerisch sein.
    const mockChannel = { id: '999999999999999801', send: async () => { sendCount++; } };

    const guild = {
      id: G,
      roles: { everyone: { id: 'everyone_role' } },
      client: { user: { id: 'bot_id' } },
      channels: {
        fetch: async () => null, // noch kein Kanal vorhanden
        create: async () => {
          createCount++;
          await tick(20); // Race-Fenster künstlich vergrößern, damit konkurrierende Joins wirklich überlappen
          return mockChannel;
        },
      },
    };

    const results = await Promise.all(
      Array.from({ length: 20 }, () => getOrCreateSharedVerifyChannel(guild)),
    );

    assert.equal(createCount, 1, 'trotz 20 gleichzeitiger Joins darf channels.create nur EINMAL aufgerufen werden');
    assert.equal(sendCount, 1, 'das Embed darf nur einmal gepostet werden');
    for (const r of results) {
      assert.equal(r, mockChannel, 'alle 20 Aufrufe müssen denselben Channel zurückgeben');
    }
    console.log('✓ Test 1: 20 gleichzeitige Joins erzeugen genau einen Verify-Channel (Raid-DoS-Schutz)');
  }

  // Für Test 2 wieder auf "kein Channel konfiguriert" zurücksetzen.
  await getPool().execute('UPDATE guilds SET captcha_channel_id = NULL WHERE guild_id = ?', [G]);
  config.invalidateGuildRowCache(G);

  // Test 2: Ein fehlgeschlagener Erstellungsversuch darf die dedup-Map (`creating`) nicht
  // mit einem rejected Promise vergiften — der nächste Aufruf muss einen frischen Versuch starten.
  {
    let createCount = 0;
    let shouldFail = true;
    const mockChannel2 = { id: '999999999999999802', send: async () => {} };

    const guild = {
      id: G,
      roles: { everyone: { id: 'everyone_role' } },
      client: { user: { id: 'bot_id' } },
      channels: {
        fetch: async () => null,
        create: async () => {
          createCount++;
          await tick(5);
          if (shouldFail) {
            shouldFail = false;
            throw new Error('simulierter Discord-API-Fehler');
          }
          return mockChannel2;
        },
      },
    };

    await assert.rejects(
      () => getOrCreateSharedVerifyChannel(guild),
      /simulierter Discord-API-Fehler/,
      'erster Aufruf muss den simulierten Fehler durchreichen',
    );

    const second = await getOrCreateSharedVerifyChannel(guild);
    assert.equal(second, mockChannel2, 'nach dem Fehlschlag muss der nächste Aufruf erfolgreich einen Channel erzeugen');
    assert.equal(createCount, 2, 'genau ein Retry-create nach dem Fehlschlag — kein gecachtes rejected Promise');
    console.log('✓ Test 2: Fehlgeschlagene Erstellung vergiftet die dedup-Map nicht, Retry erzeugt genau einen Channel');
  }

  await getPool().execute('DELETE FROM guilds WHERE guild_id = ?', [G]);

  console.log('OK — verifyChannel dedup passed');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
