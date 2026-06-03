# Stage 4 — Utility Commands Design

**Date:** 2026-06-03
**Status:** Approved (brainstorming session)
**Author:** Lukas (mit Claude Opus 4.7)

**Note zum Stage-Marker:** Der ursprüngliche Schema-Marker `Stage 4` in `server/schema.sql:83` (`automod_exemptions` Tabelle) war für Automod gedacht. Diese Stage 4 ist stattdessen Utility-Commands; Automod rückt auf Stage 5.

---

## 1. Ziel & Scope

**Was die Stage baut:** 8 neue Slash-Commands, die typische Mod-Daily-Tasks abdecken die Oreo bisher nicht hat:

- **Destruktiv** (moderator-tier): `/cleanup`, `/slowmode`, `/lockdown`, `/unlock`
- **Read-only** (supporter-tier): `/userinfo`, `/serverinfo`, `/roleinfo`, `/avatar`

**Tier-Gates:** moderator-tier für Discord-State-Mutations (cleanup/slowmode/lockdown/unlock), supporter-tier für Info-Lookups (userinfo/serverinfo/roleinfo/avatar).

**Schema-Change:** Keine. Alle Operationen sind Discord-Side-Effects oder DB-Reads gegen existierende Tabellen (`infractions` für /userinfo Case-Stats).

**Mod-Log-Integration:** Die 4 destruktiven Commands posten leichtgewichtige Audit-Embeds (inline-built, kein zentraler Factory-Eintrag). Read-only Commands schreiben nichts in Mod-Log.

**Out-of-Scope** (bewusst weggelassen):

- `/nuke` (Channel-Recreate) — zu destruktiv für M-Stage
- `/note` (Mod-Notes mit DB-Persistenz) — eigene Stage wenn gewünscht
- `/say`, `/embed` (Bot-Sprech) — Audit-Risk
- `/poll`, `/remindme` — eigene Komplexität (Reactions vs Buttons, Cron-Job)
- `/channel-clone`, `/voice-move`, `/role-give-many` — selten genug für YAGNI
- Per-Command konfigurierbare Tier-Gates
- Reason-Parameter im Lockdown (würde Channel-Topic-Backup brauchen)
- Multi-Channel-Lockdown (immer current channel)
- `/cleanup amount > 100` (Discord-Limit, kein workaround in dieser Stage)
- Extending `src/modlog.js` `buildModLogEmbed` für die 4 utility-actions (Stage 2d §3.5 sagt: nur warn/timeout/kick/ban)

## 2. Modul-Layout

```
NEU (alle in src/commands/)
├── cleanup.js       — bulk message delete mit Filtern
├── slowmode.js      — Channel-Slowmode setzen
├── lockdown.js      — @everyone SendMessages = deny
├── unlock.js        — @everyone SendMessages = inherit (clear override)
├── userinfo.js      — full mod-context user lookup
├── serverinfo.js    — guild stats
├── roleinfo.js      — role details
└── avatar.js        — user avatar standalone

GEÄNDERT
└── (nichts)
```

**Modul-Boundaries:**

- Jeder Command ist **self-contained**, importiert was er braucht (`config` für mod-log channel, `cases` für /userinfo Case-Stats, etc.)
- **Kein neues Top-Level-Modul.** Die 4 destruktiven Commands bauen Mod-Log-Embeds inline (analog Stage 3 `postEscalationFailEmbed` in `escalations.js`)
- `src/loadCommands.js` registriert die 8 neuen Files automatisch (existierender file-glob-loader, Stage 1)
- `src/deployCommands.js` pickt sie automatisch (gleicher Mechanismus)

**Abhängigkeiten:**

| Command | Imports |
|---|---|
| `cleanup.js` | `discord.js` (PermissionFlagsBits, EmbedBuilder, MessageFlags), `../config` |
| `slowmode.js` | `discord.js`, `../config`, `../duration` (parseDuration, formatDuration) |
| `lockdown.js` | `discord.js`, `../config` |
| `unlock.js` | `discord.js`, `../config` |
| `userinfo.js` | `discord.js`, `../db` (getPool — direct GROUP-BY-query auf infractions) |
| `serverinfo.js` | `discord.js` |
| `roleinfo.js` | `discord.js` |
| `avatar.js` | `discord.js` |

## 3. Destruktive Commands

### 3.1 `/cleanup` — Bulk-Message-Delete

**Slash-Builder:**

```js
new SlashCommandBuilder()
  .setName('cleanup')
  .setDescription('Löscht die letzten N Messages (optional gefiltert).')
  .addIntegerOption((o) => o.setName('amount').setDescription('Anzahl Messages (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
  .addUserOption((o) => o.setName('user').setDescription('Nur Messages von diesem User').setRequired(false))
  .addStringOption((o) => o.setName('contains').setDescription('Nur Messages die diesen Text enthalten').setRequired(false))
  .addBooleanOption((o) => o.setName('bots_only').setDescription('Nur Bot-Messages').setRequired(false))
```

`requiredTier: 'moderator'`.

**Execute-Flow:**

1. Bot-Permission-Check: `ManageMessages` im aktuellen Channel → wenn fehlt: ❌ ephemeral, return
2. Channel-Type-Check (siehe §5.2)
3. `channel.messages.fetch({ limit: amount })` → die N neuesten Messages
4. Filter anwenden:
   - `user` → `m.author.id === user.id`
   - `contains` → `m.content?.toLowerCase().includes(contains.toLowerCase())`
   - `bots_only` → `m.author.bot`
5. Filter Messages >14 Tage alt aus (Client-side; bulkDelete würde sonst error)
6. Wenn `filtered.length === 0`: ephemeral `⚠️ Keine Messages matchen den Filter (von N geprüften).` + return (kein Mod-Log)
7. `channel.bulkDelete(filtered, true)` — `true` filtert silent zusätzliche >14d Messages
8. Reply: `✅ {deletedCount} Messages gelöscht.` + Warning wenn `skipped > 0`
9. Mod-Log-Embed posten (siehe §3.5)

### 3.2 `/slowmode` — Channel-Slowmode setzen

**Slash-Builder:**

```js
new SlashCommandBuilder()
  .setName('slowmode')
  .setDescription('Setzt den Slowmode des aktuellen Channels.')
  .addStringOption((o) => o.setName('duration').setDescription('Dauer (0s = aus, max 6h) — z.B. 30s, 5m, 1h').setRequired(true))
```

`requiredTier: 'moderator'`.

**Execute-Flow:**

1. Bot-Permission: `ManageChannels` im aktuellen Channel
2. Channel-Type-Check
3. `durationMs = parseDuration(duration)`:
   - `null` → ❌ ephemeral `Ungültige Dauer-Angabe.`
   - `> 21600 * 1000` (6h Discord-Limit) → ❌ `Max. Slowmode ist 6 Stunden.`
4. `seconds = Math.floor(durationMs / 1000)` (kann 0 sein → off)
5. `await channel.setRateLimitPerUser(seconds)`
6. Reply: `✅ Slowmode auf {formatDuration(durationMs)} gesetzt.` bei seconds > 0, sonst `✅ Slowmode deaktiviert.`
7. Mod-Log-Embed posten

**Edge:** `0s` → 0 ms → setRateLimitPerUser(0) → off. parseDuration("0s") liefert 0 (nicht null).

### 3.3 `/lockdown` — Channel sperren

**Slash-Builder:** Keine Optionen (immer current channel).

`requiredTier: 'moderator'`.

**Execute-Flow:**

1. Bot-Permission: `ManageRoles` + `ManageChannels` im aktuellen Channel
2. Channel-Type-Check
3. Idempotenz: `currentOverwrite = channel.permissionOverwrites.cache.get(everyone.id)`; wenn `currentOverwrite?.deny?.has(PermissionFlagsBits.SendMessages)` → ephemeral `Channel ist bereits gesperrt.` + return (kein Mod-Log)
4. `await channel.permissionOverwrites.edit(everyone, { SendMessages: false })`
5. Reply: `🔒 Channel gesperrt.`
6. Mod-Log-Embed posten

### 3.4 `/unlock` — Channel entsperren

**Slash-Builder:** Keine Optionen.

`requiredTier: 'moderator'`.

**Execute-Flow:**

1. Bot-Permission: `ManageRoles` + `ManageChannels`
2. Channel-Type-Check
3. Idempotenz: wenn `!currentOverwrite?.deny?.has(SendMessages)` → ephemeral `Channel ist nicht gesperrt.` + return
4. `await channel.permissionOverwrites.edit(everyone, { SendMessages: null })` (null = inherit/clear)
5. Reply: `🔓 Channel entsperrt.`
6. Mod-Log-Embed posten

### 3.5 Mod-Log-Embed Pattern (inline pro Command)

Keine zentrale Factory. Embed-Shape:

```js
const embed = new EmbedBuilder()
  .setTitle('🧹 Cleanup' | '⏳ Slowmode' | '🔒 Lockdown' | '🔓 Unlock')
  .setColor(0x5865f2)  // blurple — utility, nicht Strafe
  .addFields(
    { name: '🛡️ Moderator', value: `<@${mod.id}>`, inline: true },
    { name: '📺 Channel', value: `<#${channel.id}>`, inline: true },
    // command-spezifische Fields:
    //   cleanup: '🗑️ Gelöscht', value: 'N Messages' (+ optional 'Filter', value: 'user=X, contains="...", bots_only')
    //   slowmode: '⏱️ Neue Dauer', value: formatDuration(durationMs) (oder 'deaktiviert')
    //   lockdown/unlock: keine zusätzlichen
  )
  .setFooter({ text: '🐾 Oreo' })
  .setTimestamp();
```

**Posting-Pipeline (fail-soft):**

```js
try {
  const modLogChannelId = await config.getModLogChannelId(interaction.guildId);
  if (modLogChannelId) {
    const modLogChannel = await interaction.client.channels.fetch(modLogChannelId);
    if (modLogChannel) {
      await modLogChannel.send({ embeds: [embed] });
    }
  }
} catch (err) {
  console.warn(`[${commandName}] modlog post failed:`, err);
}
```

Fail-soft: wenn Mod-Log-Channel nicht konfiguriert oder send wirft → `console.warn`, **kein** follow-up an User (Aktion war erfolgreich).

## 4. Read-only Commands

### 4.1 `/userinfo`

**Slash-Builder:**

```js
new SlashCommandBuilder()
  .setName('userinfo')
  .setDescription('Zeigt Informationen über einen User (Account, Server, Cases).')
  .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
```

`requiredTier: 'supporter'`.

**Execute-Flow:**

1. `user = interaction.options.getUser('user')`
2. `member = await interaction.guild.members.fetch(user.id).catch(() => null)`
3. DB-Query Case-Stats:

   ```sql
   SELECT type, active, COUNT(*) AS count
     FROM infractions
    WHERE guild_id = ? AND user_id = ?
    GROUP BY type, active;
   ```

   Aggregation in Code: `{ warnActive, warnTotal, timeoutTotal, kickTotal, banTotal }`. Bei DB-Fehler: ephemeral `Datenbankfehler — versuch es später.`
4. Build embed (§4.5)
5. Reply ephemeral

**Embed-Layout:**

- Title: `👤 ${user.tag}`
- Thumbnail: `user.displayAvatarURL({ size: 256 })`
- Color: `0x5865f2`
- Fields:
  - `🆔 User-ID`: `${user.id}` (inline=true)
  - `📅 Account erstellt`: `<t:${createdSec}:f> (<t:${createdSec}:R>)` (inline=true)
  - `🚪 Server-Beitritt`: wenn `member`: `<t:${joinedSec}:f> (<t:${joinedSec}:R>)`; sonst `nicht auf dem Server` (inline=true)
  - `🎭 Rollen`: wenn `member`: top-10 Roles als `<@&id>` joined by `, ` + `(+N weitere)` Suffix wenn >10; sonst `—` (inline=false)
  - `⚖️ Cases`: multi-line block:

    ```
    ⚠️ Warns: {warnTotal} ({warnActive} aktiv)
    ⏱️ Timeouts: {timeoutTotal}
    👢 Kicks: {kickTotal}
    🔨 Bans: {banTotal}
    ```

    (inline=false)
- Footer: `🐾 Oreo`
- `.setTimestamp()`

### 4.2 `/serverinfo`

**Slash-Builder:** Keine Optionen. `requiredTier: 'supporter'`.

**Execute-Flow:**

1. `guild = interaction.guild`
2. Counts collecten (alle aus cache):
   - `memberCount = guild.memberCount`
   - `channelCount = guild.channels.cache.size`
   - `roleCount = guild.roles.cache.size - 1` (minus @everyone)
   - `boostCount = guild.premiumSubscriptionCount ?? 0`
   - `boostTier = guild.premiumTier` (NONE/TIER_1/TIER_2/TIER_3)
3. Build embed

**Embed-Layout:**

- Title: `🛡️ ${guild.name}`
- Thumbnail: `guild.iconURL({ size: 256 })` (kann null sein → kein Thumbnail)
- Color: `0x5865f2`
- Fields:
  - `🆔 Guild-ID` (inline=true)
  - `👑 Owner`: `<@${guild.ownerId}>` (inline=true)
  - `📅 Erstellt`: `<t:${createdSec}:f> (<t:${createdSec}:R>)` (inline=true)
  - `👥 Members`: `${memberCount}` (inline=true)
  - `📺 Channels`: `${channelCount}` (inline=true)
  - `🎭 Rollen`: `${roleCount}` (inline=true)
  - `🚀 Boost`: `${boostCount} Boosts (Tier ${boostTier})` (inline=false)
- Footer + Timestamp

### 4.3 `/roleinfo`

**Slash-Builder:**

```js
.addRoleOption((o) => o.setName('role').setDescription('Rolle').setRequired(true))
```

`requiredTier: 'supporter'`.

**Execute-Flow:**

1. `role = interaction.options.getRole('role')`
2. `memberCount = role.members.size` (cache-based — bei großen Guilds evtl. unvollständig; akzeptiert für M-Stage)
3. Build embed

**Embed-Layout:**

- Title: `🎭 ${role.name}`
- Color: `role.color || 0x5865f2`
- Fields:
  - `🆔 Role-ID` (inline=true)
  - `🎨 Farbe`: `#${role.color.toString(16).padStart(6, '0')}` oder `keine` wenn `role.color === 0` (inline=true)
  - `📅 Erstellt` (inline=true)
  - `👥 Members`: `${memberCount}` (inline=true)
  - `📌 Hoisted`: `${role.hoist ? 'ja' : 'nein'}` (inline=true)
  - `🔔 Mentionable`: `${role.mentionable ? 'ja' : 'nein'}` (inline=true)
  - `🤖 Managed`: `${role.managed ? 'ja (bot/integration)' : 'nein'}` (inline=true)
- Footer + Timestamp

### 4.4 `/avatar`

**Slash-Builder:**

```js
.addUserOption((o) => o.setName('user').setDescription('User (default: du selbst)').setRequired(false))
```

`requiredTier: 'supporter'`.

**Execute-Flow:**

1. `user = interaction.options.getUser('user') ?? interaction.user`
2. `member = await interaction.guild.members.fetch(user.id).catch(() => null)`
3. Avatar-Resolution:
   - Wenn `member` + `member.avatar !== null` (member-spezifischer Avatar gesetzt):
     - Main image: `member.displayAvatarURL({ size: 4096 })`
     - Wenn `user.displayAvatarURL() !== member.displayAvatarURL()`: Description = `[User-Avatar (global)](${user.displayAvatarURL({ size: 4096 })})`
   - Sonst:
     - Main image: `user.displayAvatarURL({ size: 4096 })`
     - Keine Description
4. Build embed

**Embed-Layout:**

- Title: `🖼️ Avatar von ${user.tag}`
- Image: voller Avatar (size 4096)
- Description: optional Link zum global avatar (siehe oben)
- Color: `0x5865f2`
- Footer: `🐾 Oreo`

### 4.5 Gemeinsame Eigenschaften (alle 4 read-only)

- Reply **ephemeral** (`flags: MessageFlags.Ephemeral`) — Mods checken privat
- `0x5865f2` Default-Color (außer roleinfo der die Rollenfarbe nimmt)
- Footer `🐾 Oreo`, `.setTimestamp()`
- **Kein** Mod-Log-Post
- **Kein** DB-Write
- **Kein** Discord-State-Change

## 5. Validation & Failure-Modes

### 5.1 Bot-Permission-Checks (destruktive Commands)

| Command | Erforderlich | Check |
|---|---|---|
| /cleanup | `ManageMessages` | `channel.permissionsFor(bot).has(PermissionFlagsBits.ManageMessages)` |
| /slowmode | `ManageChannels` | gleicher pattern |
| /lockdown | `ManageRoles` + `ManageChannels` | `.has([ManageRoles, ManageChannels])` |
| /unlock | gleich wie /lockdown | gleich |

Failure-Reply: `❌ Mir fehlt die Permission \`${name}\` in <#${channel.id}>.` ephemeral. Aktion nicht durchgeführt, kein Mod-Log.

### 5.2 Channel-Type-Check

`/cleanup`, `/slowmode`, `/lockdown`, `/unlock` operieren auf TextChannels:

```js
if (!channel.isTextBased() || channel.isDMBased()) {
  return interaction.reply({ content: '❌ Nur Text-Channels.', flags: MessageFlags.Ephemeral });
}
```

Threads/Forums: pragmatisch versuchen, Discord-Errors abfangen. /lockdown auf Thread overrides nichts Sinnvolles (Threads erben Permissions vom Parent), aber crash-frei.

### 5.3 Generisches Discord-API-Failure-Pattern

```js
try {
  await action();
} catch (err) {
  console.warn(`/${command} action failed for guild ${interaction.guildId}:`, err);
  return interaction.reply({
    content: `❌ Aktion fehlgeschlagen: ${err.code ?? err.message ?? 'unbekannter Fehler'}`,
    flags: MessageFlags.Ephemeral,
  });
}
```

### 5.4 /cleanup Edge-Cases

| Fall | Verhalten |
|---|---|
| `amount=5`, Channel hat <5 Messages | Discord liefert weniger; bulkDelete läuft; Reply: `✅ N gelöscht.` |
| Alle gefilterten Messages >14d | bulkDelete returned 0 (oder skipped silently); Reply: `⚠️ 0 gelöscht. Alle Messages sind älter als 14 Tage.` |
| Filter matched 0 von N | Reply: `⚠️ Keine Messages matchen den Filter (von N geprüften).` Mod-Log skipped |
| Pinned Messages | bulkDelete löscht ohne Pin-Check; akzeptiert |
| Mehrere Filter kombiniert | AND-Verknüpfung (alle aktiven Filter müssen matchen) |

### 5.5 /lockdown + /unlock Idempotenz-Matrix

| Aktion | Aktueller @everyone-Override | Verhalten |
|---|---|---|
| /lockdown | SendMessages = false (already denied) | Skip, ephemeral `Channel ist bereits gesperrt.`, kein Mod-Log |
| /lockdown | SendMessages = true (explicit allow) | Override → false. Mod-Log. **Note:** explicit-allow geht verloren — /unlock setzt auf inherit |
| /lockdown | SendMessages = null (inherit) | Override → false. Mod-Log |
| /unlock | SendMessages = false | Override → null (clear). Mod-Log |
| /unlock | SendMessages = null or true | Skip, ephemeral `Channel ist nicht gesperrt.`, kein Mod-Log |

### 5.6 /slowmode Edge-Cases

| Input | Verhalten |
|---|---|
| `0s` / `0m` / `0h` | parseDuration → 0 → setRateLimitPerUser(0) → off. Reply: `✅ Slowmode deaktiviert.` |
| Garbage (z.B. `abc`, `5`) | parseDuration → null → ❌ `Ungültige Dauer-Angabe.` |
| `7h` (> 6h) | `> 21600 * 1000` → ❌ `Max. Slowmode ist 6 Stunden.` |
| Current === requested | Discord no-op; Bot postet trotzdem Reply + Mod-Log (kein idempotenz-skip — Re-Setzen ist normal) |

### 5.7 Read-only Failure

| Command | Failure | Verhalten |
|---|---|---|
| /userinfo | DB-Query fails | ephemeral `Datenbankfehler — versuch es später.`, kein Embed |
| /userinfo | member.fetch wirft (user nicht im Server) | `member = null`, Embed zeigt "nicht auf dem Server" |
| /serverinfo | nichts kann failen (alles cached) | n/a |
| /roleinfo | `role.members.size` unvollständig in großen Guilds | Counter potenziell zu niedrig; akzeptiert für M-Stage |
| /avatar | user ohne custom avatar | Discord-default-Avatar (purple-Logo) wird angezeigt |

## 6. Testing

### 6.1 Smoke-Tests

**Keine neuen automated Smoke-Tests** für diese Stage. Begründung:

- 8 Commands sind primär **Discord-API-Calls + Embed-Builds**. Smoke-Test ohne Discord-Mock bringt wenig
- `/userinfo` macht einen DB-Read auf `infractions` — Mock-Discord würde mehr Code als der Command selbst kosten
- Stage 3's `escalations.js`-Test war DAL-only; Utility-Commands haben kein DAL

**Module-Load-Check** (analog prior stages):

```powershell
node --env-file=.env -e "['cleanup','slowmode','lockdown','unlock','userinfo','serverinfo','roleinfo','avatar'].forEach(n => { const c = require('./src/commands/' + n); console.log(n, typeof c.execute, typeof c.data); })"
```

Erwartet: 8 Zeilen `<name> function object`. Catches Syntax-Errors + fehlende `data`/`execute` exports.

### 6.2 Manuelle E2E

**Setup:**

- Test-Guild mit Mod-Log konfiguriert (Stage 2b)
- Owner-Account + Moderator-Account + Supporter-Account + Member-Account
- Bot hat `ManageMessages`, `ManageChannels`, `ManageRoles` Permissions
- Test-Channel mit mind. 30 Messages (mix aus User- + Bot-Messages)

**Permission-Gating (P1–P3):**

- [ ] **P1** Supporter ruft `/cleanup amount:5` → ❌ Permission denied (moderator-required)
- [ ] **P2** Member ruft `/userinfo user:@x` → ❌ Permission denied (supporter-required)
- [ ] **P3** Owner ruft `/lockdown` → ✅ allowed

**/cleanup (CL1–CL6):**

- [ ] **CL1** `/cleanup amount:5` → 5 neueste Messages weg, Reply `✅ 5 Messages gelöscht.`, Mod-Log mit 🧹 Cleanup
- [ ] **CL2** `/cleanup amount:10 user:@member` → nur Member-Messages weg (max 10), Mod-Log mit Filter-Anzeige
- [ ] **CL3** `/cleanup amount:20 bots_only:true` → nur Bot-Messages weg
- [ ] **CL4** `/cleanup amount:5 contains:test` → nur Messages mit "test" (case-insensitive)
- [ ] **CL5** `/cleanup amount:100` in Channel mit >14d Messages → ⚠️ Reply zeigt skip-count
- [ ] **CL6** `/cleanup amount:5 user:@nicht_existierend_dort` → ⚠️ "Keine Messages matchen den Filter", kein Mod-Log

**/slowmode (SM1–SM4):**

- [ ] **SM1** `/slowmode duration:30s` → Slowmode = 30s, Reply ✅, Mod-Log mit ⏳ Slowmode
- [ ] **SM2** `/slowmode duration:0s` → off, Reply `Slowmode deaktiviert`
- [ ] **SM3** `/slowmode duration:7h` → ❌ "Max. Slowmode ist 6 Stunden"
- [ ] **SM4** `/slowmode duration:garbage` → ❌ "Ungültige Dauer-Angabe"

**/lockdown + /unlock (LK1–LK5):**

- [ ] **LK1** `/lockdown` in offenem Channel → 🔒, @everyone kann nicht schreiben, Mod-Log mit 🔒
- [ ] **LK2** `/lockdown` in bereits gesperrtem Channel → "bereits gesperrt", kein Mod-Log-Repeat
- [ ] **LK3** `/unlock` in gesperrtem → 🔓, @everyone kann wieder schreiben, Mod-Log mit 🔓
- [ ] **LK4** `/unlock` in offenem → "nicht gesperrt", kein Mod-Log
- [ ] **LK5** Während Lockdown: Member-Account versucht Nachricht → Discord blockt mit Permission-Hint

**/userinfo (UI1–UI4):**

- [ ] **UI1** `/userinfo user:@member` (Member, keine Cases) → Embed komplett, Cases alle 0
- [ ] **UI2** `/userinfo user:@member` nach `/warn` + `/timeout` → Warns: 1 (1 aktiv), Timeouts: 1
- [ ] **UI3** `/userinfo user:<ID nicht-Server-Member>` → "nicht auf dem Server" für Roles/Join
- [ ] **UI4** `/userinfo user:@bot` → funktioniert, zeigt Bot-Daten

**/serverinfo + /roleinfo + /avatar (IF1–IF4):**

- [ ] **IF1** `/serverinfo` → Embed mit Counts, Owner, Boost-Stats
- [ ] **IF2** `/roleinfo role:@some_role` → Embed mit Color, Members-Count, Flags
- [ ] **IF3** `/avatar` (ohne user) → eigener Avatar
- [ ] **IF4** `/avatar user:@x` mit Server-spezifischem Avatar → Member-Avatar als Image, User-Avatar-Link in Description

**Out-of-Scope-Verifikation (X1–X3):**

- [ ] **X1** Read-only Commands posten KEIN Mod-Log
- [ ] **X2** Read-only Commands ändern KEINEN Discord-State
- [ ] **X3** Bot ohne `ManageMessages` → `/cleanup` schlägt mit Permission-Error ab, kein Mod-Log

## 7. Rollback

- **`src/commands/*.js` Files**: löschen, slash-redeploy → die 8 Commands verschwinden aus Discord
- **Kein Schema, kein DB-State** — keine Migration zu reverten
- **Kein Mod-Log-Daten in DB** — Embeds sind nur Discord-Channel-Messages (persistieren in der Channel-History)
- **Permission-Overrides aus /lockdown bleiben**: bei Rollback während gelocktem Channel müsste der Override manuell entfernt werden (via Discord-UI oder erneutem /unlock vor Rollback)
- **Slowmode-Settings bleiben**: gleiche Logik — Channel-State persistiert über Bot-Lifecycle

Volle Reversibilität auf Bot-Seite ohne Daten-Verlust.

## 8. Open Questions / Future Work

- **Per-Command-Tier-Override** via `/config command-tier set` — wenn ein Guild Supporter erlauben will /cleanup zu nutzen
- **/cleanup amount > 100** via mehrfache bulkDelete-Calls (Latency-Tradeoff)
- **/lockdown reason** — Channel-Topic-Override mit Backup-Pattern (Stage 4b wenn gewünscht)
- **/cleanup mit pinned-protection** (skip pinned messages by default)
- **/note** als separate Stage mit `mod_notes` Tabelle
- **/poll**, **/remindme**, **/say**, **/embed** — eigene Stages
- **/serverinfo Erweiterung** — Channels-by-type breakdown, role-tree visualization
- **/userinfo Last-Action-Timestamp** — `ORDER BY created_at DESC LIMIT 1` Query

## 9. File-Plan-Summary

```
NEU (8 files, alle in src/commands/)
├── cleanup.js                                      (~70 LoC)
├── slowmode.js                                     (~50 LoC)
├── lockdown.js                                     (~50 LoC)
├── unlock.js                                       (~50 LoC)
├── userinfo.js                                     (~80 LoC)
├── serverinfo.js                                   (~50 LoC)
├── roleinfo.js                                     (~50 LoC)
└── avatar.js                                       (~40 LoC)

GEÄNDERT
└── (nichts)

ENTFERNT
└── (nichts)
```

Netto-Delta: ca. **+440 LoC**, 8 neue Command-Files, keine Schema- oder Module-Änderungen. Ähnliche Größe wie Stage 2c (Report-System).
