# Config-Channels (Stage 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-Guild-Config für `report_channel`, `mod_log_channel` und `automod_enabled` via neuen `/config channel` + `/config feature` Subcommands plus ein `/config show` Dashboard, und Migration der 8 Mod-Commands von `process.env.MODLOG_CHANNEL_ID` zu DB-first-Lookup mit env-Fallback.

**Architecture:** Neues Reader-Modul `src/config.js` mit DB-first + env-Fallback API. `src/commands/config.js` wird um drei Subcommand-Gruppen erweitert (channel, feature, show) mit Permission-Validation für Channel-Set. Die 8 Mod-Commands (ban, kick, reason, removewarn, timeout, unban, untimeout, warn) tauschen ihre `process.env`-Lookups gegen `config.getModLogChannelId(guildId)` mit graceful unconfigured-UX.

**Tech Stack:** Node.js (CommonJS), discord.js v14.26, mysql2/promise, MySQL 8.x.

**Spec:** [docs/superpowers/specs/2026-05-31-config-channels-stage2b-design.md](../specs/2026-05-31-config-channels-stage2b-design.md)

**Branch:** `main` (Stage 2a wurde direkt auf main gemerged; 2b folgt dem gleichen Workflow).

**Testing-Hinweis:** Keine Test-Suite (per Projekt-Konvention). Smoke-Tests pro Reader/Command-Task gegen Docker MySQL + manuelle Discord-Verifikation in Task 7.

---

## File Structure

**Zu erstellen:**
- `src/config.js` — Per-Guild-Config-Reader mit env-Fallback

**Zu editieren:**
- `src/commands/config.js` — Neue Subcommand-Groups `channel` + `feature` + top-level Subcommand `show`
- `src/commands/ban.js` — `getModLogChannelId` statt `process.env.MODLOG_CHANNEL_ID`
- `src/commands/kick.js` — dito
- `src/commands/reason.js` — dito
- `src/commands/removewarn.js` — dito
- `src/commands/timeout.js` — dito
- `src/commands/unban.js` — dito
- `src/commands/untimeout.js` — dito
- `src/commands/warn.js` — dito

**Schema:** Keine Änderungen. `guilds`-Tabelle hat seit Stage 1 die Spalten `report_channel_id`, `mod_log_channel_id`, `automod_enabled`, `next_case_number`.

---

## Task 0: State-Confirmation

**Files:** keine

- [ ] **Step 1: Branch-State prüfen**

Run:
```bash
git status && git log --oneline -3
```

Expected: `On branch main`, working tree clean, top-3 commits beinhalten `a59aea2 docs: add config-channels stage 2b spec` (oder darüber). Falls nicht: STOP — Stage 2a / Spec-Commit müssen vorher auf main sein.

- [ ] **Step 2: Docker MySQL läuft?**

Run:
```bash
docker ps --filter "name=mysql" --format "{{.Names}}: {{.Status}}"
```

Expected: Ein MySQL-Container mit Status "Up". Falls leer: `docker compose up -d` zuerst ausführen.

---

## Task 1: `src/config.js` — Reader-Modul + Smoke-Test

**Files:**
- Create: `src/config.js`

- [ ] **Step 1: Datei mit Reader-API anlegen**

Write `src/config.js`:

```js
const { getPool } = require('./db');

/**
 * Liest die Config-Row einer Guild aus `guilds`.
 * @param {string} guildId
 * @returns {Promise<{mod_log_channel_id: string|null, report_channel_id: string|null, automod_enabled: number}|null>}
 */
async function readGuildRow(guildId) {
  const [rows] = await getPool().execute(
    'SELECT mod_log_channel_id, report_channel_id, automod_enabled FROM guilds WHERE guild_id = ?',
    [guildId],
  );
  return rows[0] ?? null;
}

/**
 * Liefert die mod-log-channel-ID für eine Guild.
 * Reihenfolge: 1) guilds.mod_log_channel_id, 2) process.env.MODLOG_CHANNEL_ID, 3) null.
 * @param {string} guildId
 * @returns {Promise<string|null>}  Snowflake-String oder null wenn nicht konfiguriert
 */
async function getModLogChannelId(guildId) {
  const row = await readGuildRow(guildId);
  const dbValue = row?.mod_log_channel_id ?? null;
  if (dbValue) return String(dbValue);
  return process.env.MODLOG_CHANNEL_ID || null;
}

/**
 * Liefert die report-channel-ID. Kein env-Fallback.
 * @param {string} guildId
 * @returns {Promise<string|null>}
 */
async function getReportChannelId(guildId) {
  const row = await readGuildRow(guildId);
  return row?.report_channel_id ? String(row.report_channel_id) : null;
}

/**
 * Liefert ob automod für die Guild aktiviert ist. Default: false.
 * @param {string} guildId
 * @returns {Promise<boolean>}
 */
async function isAutomodEnabled(guildId) {
  const row = await readGuildRow(guildId);
  return Boolean(row?.automod_enabled);
}

module.exports = {
  getModLogChannelId,
  getReportChannelId,
  isAutomodEnabled,
};
```

- [ ] **Step 2: Syntax-Check**

Run:
```bash
node -e "require('./src/config.js'); console.log('config loaded OK')"
```

Expected: `config loaded OK`.

- [ ] **Step 3: Smoke-Test gegen Docker MySQL**

Write `_smoke_config.js` in repo root (KEIN `require('dotenv')` — Projekt nutzt natives `--env-file`):

```js
const config = require('./src/config');
const { getPool } = require('./src/db');

(async () => {
  const pool = getPool();
  const guildId = '123456789';
  const channelA = '987654321111';
  const channelB = '987654321222';

  // Reset Test-Daten
  await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [guildId]);
  await pool.execute(
    'UPDATE guilds SET mod_log_channel_id = NULL, report_channel_id = NULL, automod_enabled = 0 WHERE guild_id = ?',
    [guildId],
  );

  // 1. Alle null → für mod_log kommt env-Fallback (oder null wenn env leer)
  const envSaved = process.env.MODLOG_CHANNEL_ID;
  delete process.env.MODLOG_CHANNEL_ID;
  console.log('null DB + null env → mod_log:', await config.getModLogChannelId(guildId), '(expected null)');
  process.env.MODLOG_CHANNEL_ID = 'env-fallback-123';
  console.log('null DB + env set →   mod_log:', await config.getModLogChannelId(guildId), '(expected env-fallback-123)');

  // 2. DB-Wert überschreibt env
  await pool.execute('UPDATE guilds SET mod_log_channel_id = ? WHERE guild_id = ?', [channelA, guildId]);
  console.log('DB set + env set →    mod_log:', await config.getModLogChannelId(guildId), '(expected ' + channelA + ')');

  // 3. report-channel: kein env-Fallback
  console.log('report null →   report:', await config.getReportChannelId(guildId), '(expected null)');
  await pool.execute('UPDATE guilds SET report_channel_id = ? WHERE guild_id = ?', [channelB, guildId]);
  console.log('report set →    report:', await config.getReportChannelId(guildId), '(expected ' + channelB + ')');

  // 4. automod
  console.log('automod off →   automod:', await config.isAutomodEnabled(guildId), '(expected false)');
  await pool.execute('UPDATE guilds SET automod_enabled = 1 WHERE guild_id = ?', [guildId]);
  console.log('automod on →    automod:', await config.isAutomodEnabled(guildId), '(expected true)');

  // 5. Guild existiert nicht in DB → alle Defaults
  const unknownGuild = '999999999';
  await pool.execute('DELETE FROM guilds WHERE guild_id = ?', [unknownGuild]);
  console.log('unknown guild → mod_log:', await config.getModLogChannelId(unknownGuild), '(expected env-fallback-123)');
  console.log('unknown guild → report:',  await config.getReportChannelId(unknownGuild), '(expected null)');
  console.log('unknown guild → automod:', await config.isAutomodEnabled(unknownGuild), '(expected false)');

  // Cleanup
  await pool.execute('DELETE FROM guilds WHERE guild_id = ?', [guildId]);
  if (envSaved !== undefined) process.env.MODLOG_CHANNEL_ID = envSaved;
  else delete process.env.MODLOG_CHANNEL_ID;
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
```

Run:
```bash
node --env-file=.env _smoke_config.js
```

Expected (alle Lines):
```
null DB + null env → mod_log: null (expected null)
null DB + env set →   mod_log: env-fallback-123 (expected env-fallback-123)
DB set + env set →    mod_log: 987654321111 (expected 987654321111)
report null →   report: null (expected null)
report set →    report: 987654321222 (expected 987654321222)
automod off →   automod: false (expected false)
automod on →    automod: true (expected true)
unknown guild → mod_log: env-fallback-123 (expected env-fallback-123)
unknown guild → report: null (expected null)
unknown guild → automod: false (expected false)
```

- [ ] **Step 4: Temp-Skript löschen**

```bash
rm _smoke_config.js
```

- [ ] **Step 5: Commit**

```bash
git add src/config.js
git commit -m "feat(config): add per-guild config reader with env fallback"
```

---

## Task 2: `/config channel set/unset/list` — drei Subcommands

**Files:**
- Modify: `src/commands/config.js`

Ziel: Drei neue Subcommands unter dem `channel`-Subgroup. Die existierende `role`-Subgroup und ihre Handlers bleiben unverändert.

- [ ] **Step 1: `ChannelType` und `PermissionFlagsBits` zum require hinzufügen**

Edit `src/commands/config.js` — finde die erste Zeile:

old_string:
```js
const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
```

new_string:
```js
const { SlashCommandBuilder, MessageFlags, EmbedBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
```

- [ ] **Step 2: `CHANNEL_TYPE_CHOICES`-Konstante hinzufügen**

Edit `src/commands/config.js` — finde:

old_string:
```js
const TIER_CHOICES = [
  { name: 'supporter', value: 'supporter' },
  { name: 'moderator', value: 'moderator' },
  { name: 'owner',     value: 'owner'     },
];

const TIER_ORDER = ['owner', 'moderator', 'supporter'];
```

new_string:
```js
const TIER_CHOICES = [
  { name: 'supporter', value: 'supporter' },
  { name: 'moderator', value: 'moderator' },
  { name: 'owner',     value: 'owner'     },
];

const TIER_ORDER = ['owner', 'moderator', 'supporter'];

const CHANNEL_TYPE_CHOICES = [
  { name: 'report', value: 'report' },
  { name: 'modlog', value: 'modlog' },
];

// type → DB-Spalte
const CHANNEL_COLUMN = {
  report: 'report_channel_id',
  modlog: 'mod_log_channel_id',
};

// type → User-facing Label
const CHANNEL_LABEL = {
  report: 'report',
  modlog: 'modlog',
};
```

- [ ] **Step 3: `channel`-Subcommand-Group zum SlashCommandBuilder hinzufügen**

Edit `src/commands/config.js` — finde die `role`-SubcommandGroup-Definition (endet vor `),`):

old_string:
```js
    .addSubcommandGroup((group) =>
      group.setName('role').setDescription('Rollen-Tier-Verwaltung')
        .addSubcommand((sub) =>
          sub.setName('set').setDescription('Weist einer Rolle einen Tier zu.')
            .addRoleOption((o) => o.setName('role').setDescription('Rolle').setRequired(true))
            .addStringOption((o) => o.setName('tier').setDescription('Tier').setRequired(true).addChoices(...TIER_CHOICES))
        )
        .addSubcommand((sub) =>
          sub.setName('unset').setDescription('Entfernt den Tier einer Rolle.')
            .addRoleOption((o) => o.setName('role').setDescription('Rolle').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub.setName('list').setDescription('Zeigt alle Rollen-Tier-Zuweisungen.')
        )
    ),
```

new_string:
```js
    .addSubcommandGroup((group) =>
      group.setName('role').setDescription('Rollen-Tier-Verwaltung')
        .addSubcommand((sub) =>
          sub.setName('set').setDescription('Weist einer Rolle einen Tier zu.')
            .addRoleOption((o) => o.setName('role').setDescription('Rolle').setRequired(true))
            .addStringOption((o) => o.setName('tier').setDescription('Tier').setRequired(true).addChoices(...TIER_CHOICES))
        )
        .addSubcommand((sub) =>
          sub.setName('unset').setDescription('Entfernt den Tier einer Rolle.')
            .addRoleOption((o) => o.setName('role').setDescription('Rolle').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub.setName('list').setDescription('Zeigt alle Rollen-Tier-Zuweisungen.')
        )
    )
    .addSubcommandGroup((group) =>
      group.setName('channel').setDescription('Channel-Konfiguration (report, modlog)')
        .addSubcommand((sub) =>
          sub.setName('set').setDescription('Setzt einen Channel.')
            .addStringOption((o) => o.setName('type').setDescription('Welcher Channel').setRequired(true).addChoices(...CHANNEL_TYPE_CHOICES))
            .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
        )
        .addSubcommand((sub) =>
          sub.setName('unset').setDescription('Entfernt einen Channel.')
            .addStringOption((o) => o.setName('type').setDescription('Welcher Channel').setRequired(true).addChoices(...CHANNEL_TYPE_CHOICES))
        )
        .addSubcommand((sub) =>
          sub.setName('list').setDescription('Zeigt beide Channels.')
        )
    ),
```

- [ ] **Step 4: Dispatcher erweitern**

Edit `src/commands/config.js` — finde die existierende dispatcher-Logik in `execute`:

old_string:
```js
  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    if (group !== 'role') {
      return interaction.reply({
        content: 'Unbekannter Subcommand.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'set')   return handleRoleSet(interaction);
    if (sub === 'unset') return handleRoleUnset(interaction);
    if (sub === 'list')  return handleRoleList(interaction);
  },
```

new_string:
```js
  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (group === 'role') {
      if (sub === 'set')   return handleRoleSet(interaction);
      if (sub === 'unset') return handleRoleUnset(interaction);
      if (sub === 'list')  return handleRoleList(interaction);
    }

    if (group === 'channel') {
      if (sub === 'set')   return handleChannelSet(interaction);
      if (sub === 'unset') return handleChannelUnset(interaction);
      if (sub === 'list')  return handleChannelList(interaction);
    }

    return interaction.reply({
      content: 'Unbekannter Subcommand.',
      flags: MessageFlags.Ephemeral,
    });
  },
```

- [ ] **Step 5: `handleChannelSet`, `handleChannelUnset`, `handleChannelList` Funktionen am Ende der Datei hinzufügen**

Edit `src/commands/config.js` — finde die letzte Funktion `handleRoleList` (die mit `embed.setFooter({ text: '🐾 Oreo' });` endet, gefolgt vom finalen `return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });` und schließender `}`):

old_string (matche das Funktionsende exakt — letzte Zeile von handleRoleList vor EOF):
```js
  embed.setFooter({ text: '🐾 Oreo' });

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
```

new_string:
```js
  embed.setFooter({ text: '🐾 Oreo' });

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleChannelSet(interaction) {
  const type = interaction.options.getString('type');
  const channel = interaction.options.getChannel('channel');

  if (channel.type !== ChannelType.GuildText) {
    return interaction.reply({
      content: 'Nur Text-Channels werden unterstützt.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Permission-Check für Bot
  const botMember = interaction.guild.members.me;
  const botPerms = channel.permissionsFor(botMember);
  if (!botPerms?.has(PermissionFlagsBits.SendMessages)) {
    return interaction.reply({
      content: `Mir fehlt die Permission 'Nachrichten senden' in <#${channel.id}>. Bitte zuerst beheben.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!botPerms.has(PermissionFlagsBits.EmbedLinks)) {
    return interaction.reply({
      content: `Mir fehlt die Permission 'Embed-Links' in <#${channel.id}>. Bitte zuerst beheben.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const column = CHANNEL_COLUMN[type];
  const label = CHANNEL_LABEL[type];
  const pool = getPool();
  let previousId = null;

  try {
    await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [interaction.guildId]);
    const [existing] = await pool.execute(
      `SELECT ${column} AS value FROM guilds WHERE guild_id = ?`,
      [interaction.guildId],
    );
    previousId = existing[0]?.value ? String(existing[0].value) : null;

    await pool.execute(
      `UPDATE guilds SET ${column} = ? WHERE guild_id = ?`,
      [channel.id, interaction.guildId],
    );
  } catch (err) {
    console.error('/config channel set DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const message = previousId
    ? `Channel \`${label}\` von <#${previousId}> auf <#${channel.id}> geändert.`
    : `Channel \`${label}\` gesetzt auf <#${channel.id}>.`;

  return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}

async function handleChannelUnset(interaction) {
  const type = interaction.options.getString('type');
  const column = CHANNEL_COLUMN[type];
  const label = CHANNEL_LABEL[type];
  const pool = getPool();
  let previousId = null;

  try {
    const [existing] = await pool.execute(
      `SELECT ${column} AS value FROM guilds WHERE guild_id = ?`,
      [interaction.guildId],
    );
    previousId = existing[0]?.value ? String(existing[0].value) : null;

    if (previousId === null) {
      return interaction.reply({
        content: `Channel \`${label}\` war nicht konfiguriert — nichts zu tun.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    await pool.execute(
      `UPDATE guilds SET ${column} = NULL WHERE guild_id = ?`,
      [interaction.guildId],
    );
  } catch (err) {
    console.error('/config channel unset DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: `Channel \`${label}\` entfernt (war <#${previousId}>).`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleChannelList(interaction) {
  let row;
  try {
    const [rows] = await getPool().execute(
      'SELECT mod_log_channel_id, report_channel_id FROM guilds WHERE guild_id = ?',
      [interaction.guildId],
    );
    row = rows[0] ?? null;
  } catch (err) {
    console.error('/config channel list DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const reportId = row?.report_channel_id ? String(row.report_channel_id) : null;
  const modlogDbId = row?.mod_log_channel_id ? String(row.mod_log_channel_id) : null;
  const modlogEnvId = !modlogDbId && process.env.MODLOG_CHANNEL_ID ? process.env.MODLOG_CHANNEL_ID : null;

  const reportLine = reportId ? `<#${reportId}>` : '(nicht konfiguriert)';
  let modlogLine;
  if (modlogDbId) modlogLine = `<#${modlogDbId}>`;
  else if (modlogEnvId) modlogLine = `<#${modlogEnvId}> *(env-Fallback)*`;
  else modlogLine = '(nicht konfiguriert)';

  const embed = new EmbedBuilder()
    .setTitle('🔧 Channel-Konfiguration')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Report-Channel',  value: reportLine, inline: false },
      { name: 'Mod-Log-Channel', value: modlogLine, inline: false },
    )
    .setFooter({ text: '🐾 Oreo' });

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
```

- [ ] **Step 6: Syntax-Check**

Run:
```bash
node -c src/commands/config.js
```

Expected: no output.

- [ ] **Step 7: Smoke-Test — Subcommand-Schema lädt und exposed `channel`-Subgroup**

Run:
```bash
node -e "
const cmd = require('./src/commands/config');
const json = cmd.data.toJSON();
const groups = json.options.filter(o => o.type === 2).map(g => g.name); // type 2 = SUB_COMMAND_GROUP
console.log('Subcommand-Groups:', groups, '(expected role, channel)');
const channelGroup = json.options.find(g => g.name === 'channel');
const channelSubs = channelGroup.options.map(s => s.name);
console.log('channel Subcommands:', channelSubs, '(expected set, unset, list)');
"
```

Expected:
```
Subcommand-Groups: [ 'role', 'channel' ] (expected role, channel)
channel Subcommands: [ 'set', 'unset', 'list' ] (expected set, unset, list)
```

- [ ] **Step 8: Commit**

```bash
git add src/commands/config.js
git commit -m "feat(commands): add /config channel set/unset/list subcommands"
```

---

## Task 3: `/config feature set` — Toggle für automod_enabled

**Files:**
- Modify: `src/commands/config.js`

- [ ] **Step 1: `FEATURE_CHOICES`-Konstante hinzufügen**

Edit `src/commands/config.js` — finde:

old_string:
```js
// type → User-facing Label
const CHANNEL_LABEL = {
  report: 'report',
  modlog: 'modlog',
};
```

new_string:
```js
// type → User-facing Label
const CHANNEL_LABEL = {
  report: 'report',
  modlog: 'modlog',
};

const FEATURE_CHOICES = [
  { name: 'automod', value: 'automod' },
];

// feature → DB-Spalte
const FEATURE_COLUMN = {
  automod: 'automod_enabled',
};
```

- [ ] **Step 2: `feature`-Subcommand-Group zum SlashCommandBuilder hinzufügen**

Edit `src/commands/config.js` — finde die `channel`-SubcommandGroup-Definition (endet vor `),`):

old_string:
```js
    .addSubcommandGroup((group) =>
      group.setName('channel').setDescription('Channel-Konfiguration (report, modlog)')
        .addSubcommand((sub) =>
          sub.setName('set').setDescription('Setzt einen Channel.')
            .addStringOption((o) => o.setName('type').setDescription('Welcher Channel').setRequired(true).addChoices(...CHANNEL_TYPE_CHOICES))
            .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
        )
        .addSubcommand((sub) =>
          sub.setName('unset').setDescription('Entfernt einen Channel.')
            .addStringOption((o) => o.setName('type').setDescription('Welcher Channel').setRequired(true).addChoices(...CHANNEL_TYPE_CHOICES))
        )
        .addSubcommand((sub) =>
          sub.setName('list').setDescription('Zeigt beide Channels.')
        )
    ),
```

new_string:
```js
    .addSubcommandGroup((group) =>
      group.setName('channel').setDescription('Channel-Konfiguration (report, modlog)')
        .addSubcommand((sub) =>
          sub.setName('set').setDescription('Setzt einen Channel.')
            .addStringOption((o) => o.setName('type').setDescription('Welcher Channel').setRequired(true).addChoices(...CHANNEL_TYPE_CHOICES))
            .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
        )
        .addSubcommand((sub) =>
          sub.setName('unset').setDescription('Entfernt einen Channel.')
            .addStringOption((o) => o.setName('type').setDescription('Welcher Channel').setRequired(true).addChoices(...CHANNEL_TYPE_CHOICES))
        )
        .addSubcommand((sub) =>
          sub.setName('list').setDescription('Zeigt beide Channels.')
        )
    )
    .addSubcommandGroup((group) =>
      group.setName('feature').setDescription('Feature-Toggles')
        .addSubcommand((sub) =>
          sub.setName('set').setDescription('Schaltet ein Feature ein oder aus.')
            .addStringOption((o) => o.setName('name').setDescription('Feature-Name').setRequired(true).addChoices(...FEATURE_CHOICES))
            .addBooleanOption((o) => o.setName('value').setDescription('true = aktivieren, false = deaktivieren').setRequired(true))
        )
    ),
```

- [ ] **Step 3: Dispatcher erweitern**

Edit `src/commands/config.js` — finde:

old_string:
```js
    if (group === 'channel') {
      if (sub === 'set')   return handleChannelSet(interaction);
      if (sub === 'unset') return handleChannelUnset(interaction);
      if (sub === 'list')  return handleChannelList(interaction);
    }

    return interaction.reply({
      content: 'Unbekannter Subcommand.',
      flags: MessageFlags.Ephemeral,
    });
```

new_string:
```js
    if (group === 'channel') {
      if (sub === 'set')   return handleChannelSet(interaction);
      if (sub === 'unset') return handleChannelUnset(interaction);
      if (sub === 'list')  return handleChannelList(interaction);
    }

    if (group === 'feature') {
      if (sub === 'set') return handleFeatureSet(interaction);
    }

    return interaction.reply({
      content: 'Unbekannter Subcommand.',
      flags: MessageFlags.Ephemeral,
    });
```

- [ ] **Step 4: `handleFeatureSet`-Funktion am Ende der Datei hinzufügen**

Edit `src/commands/config.js` — finde die letzte Funktion `handleChannelList` (die mit dem Embed-Reply endet):

old_string:
```js
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
```

(Achtung — dieser Pattern `return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });` gefolgt von `}` taucht möglicherweise mehrfach auf. Verwende stattdessen das spezifische Ende von handleChannelList: die Zeile mit dem `🔧 Channel-Konfiguration`-Embed-Build.)

Bessere Variante — finde:

old_string:
```js
  const embed = new EmbedBuilder()
    .setTitle('🔧 Channel-Konfiguration')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Report-Channel',  value: reportLine, inline: false },
      { name: 'Mod-Log-Channel', value: modlogLine, inline: false },
    )
    .setFooter({ text: '🐾 Oreo' });

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
```

new_string:
```js
  const embed = new EmbedBuilder()
    .setTitle('🔧 Channel-Konfiguration')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Report-Channel',  value: reportLine, inline: false },
      { name: 'Mod-Log-Channel', value: modlogLine, inline: false },
    )
    .setFooter({ text: '🐾 Oreo' });

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleFeatureSet(interaction) {
  const name = interaction.options.getString('name');
  const value = interaction.options.getBoolean('value');
  const column = FEATURE_COLUMN[name];

  try {
    await getPool().execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [interaction.guildId]);
    await getPool().execute(
      `UPDATE guilds SET ${column} = ? WHERE guild_id = ?`,
      [value ? 1 : 0, interaction.guildId],
    );
  } catch (err) {
    console.error('/config feature set DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  let message;
  if (name === 'automod' && value) {
    message = `Feature \`automod\` aktiviert.\n⚠️ Automod-Logik ist erst ab Stage 4 implementiert. Toggle ist heute ein Stub.`;
  } else {
    message = `Feature \`${name}\` ${value ? 'aktiviert' : 'deaktiviert'}.`;
  }

  return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}
```

- [ ] **Step 5: Syntax-Check**

Run:
```bash
node -c src/commands/config.js
```

Expected: no output.

- [ ] **Step 6: Smoke-Test — `feature`-Group ist registriert**

Run:
```bash
node -e "
const cmd = require('./src/commands/config');
const json = cmd.data.toJSON();
const groups = json.options.filter(o => o.type === 2).map(g => g.name);
console.log('Subcommand-Groups:', groups, '(expected role, channel, feature)');
const featureGroup = json.options.find(g => g.name === 'feature');
const featureSubs = featureGroup.options.map(s => s.name);
console.log('feature Subcommands:', featureSubs, '(expected set)');
"
```

Expected:
```
Subcommand-Groups: [ 'role', 'channel', 'feature' ] (expected role, channel, feature)
feature Subcommands: [ 'set' ] (expected set)
```

- [ ] **Step 7: Commit**

```bash
git add src/commands/config.js
git commit -m "feat(commands): add /config feature set (automod toggle stub)"
```

---

## Task 4: `/config show` — One-stop Dashboard

**Files:**
- Modify: `src/commands/config.js`

- [ ] **Step 1: Top-level `show`-Subcommand zum SlashCommandBuilder hinzufügen**

Edit `src/commands/config.js` — finde das Ende der SubcommandGroup-Definitions (die letzte Subgroup ist `feature`, danach folgt `),`):

old_string:
```js
    .addSubcommandGroup((group) =>
      group.setName('feature').setDescription('Feature-Toggles')
        .addSubcommand((sub) =>
          sub.setName('set').setDescription('Schaltet ein Feature ein oder aus.')
            .addStringOption((o) => o.setName('name').setDescription('Feature-Name').setRequired(true).addChoices(...FEATURE_CHOICES))
            .addBooleanOption((o) => o.setName('value').setDescription('true = aktivieren, false = deaktivieren').setRequired(true))
        )
    ),
```

new_string:
```js
    .addSubcommandGroup((group) =>
      group.setName('feature').setDescription('Feature-Toggles')
        .addSubcommand((sub) =>
          sub.setName('set').setDescription('Schaltet ein Feature ein oder aus.')
            .addStringOption((o) => o.setName('name').setDescription('Feature-Name').setRequired(true).addChoices(...FEATURE_CHOICES))
            .addBooleanOption((o) => o.setName('value').setDescription('true = aktivieren, false = deaktivieren').setRequired(true))
        )
    )
    .addSubcommand((sub) =>
      sub.setName('show').setDescription('Zeigt die komplette Server-Konfiguration.')
    ),
```

- [ ] **Step 2: Dispatcher erweitern**

Edit `src/commands/config.js` — finde:

old_string:
```js
    if (group === 'feature') {
      if (sub === 'set') return handleFeatureSet(interaction);
    }

    return interaction.reply({
      content: 'Unbekannter Subcommand.',
      flags: MessageFlags.Ephemeral,
    });
```

new_string:
```js
    if (group === 'feature') {
      if (sub === 'set') return handleFeatureSet(interaction);
    }

    if (group === null && sub === 'show') {
      return handleShow(interaction);
    }

    return interaction.reply({
      content: 'Unbekannter Subcommand.',
      flags: MessageFlags.Ephemeral,
    });
```

- [ ] **Step 3: `handleShow`-Funktion am Ende der Datei hinzufügen**

Edit `src/commands/config.js` — finde das Ende der `handleFeatureSet`-Funktion:

old_string:
```js
  return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}
```

(Hinweis: Dieser exakte String taucht in mehreren Funktionen auf. Identifiziere den letzten Vorkommen — nach `handleFeatureSet`. Sicherer Kontext-Match:)

old_string:
```js
  if (name === 'automod' && value) {
    message = `Feature \`automod\` aktiviert.\n⚠️ Automod-Logik ist erst ab Stage 4 implementiert. Toggle ist heute ein Stub.`;
  } else {
    message = `Feature \`${name}\` ${value ? 'aktiviert' : 'deaktiviert'}.`;
  }

  return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}
```

new_string:
```js
  if (name === 'automod' && value) {
    message = `Feature \`automod\` aktiviert.\n⚠️ Automod-Logik ist erst ab Stage 4 implementiert. Toggle ist heute ein Stub.`;
  } else {
    message = `Feature \`${name}\` ${value ? 'aktiviert' : 'deaktiviert'}.`;
  }

  return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}

async function handleShow(interaction) {
  let guildRow;
  let roleRows;
  try {
    const pool = getPool();
    const [gRows] = await pool.execute(
      'SELECT mod_log_channel_id, report_channel_id, automod_enabled, next_case_number FROM guilds WHERE guild_id = ?',
      [interaction.guildId],
    );
    guildRow = gRows[0] ?? null;
    const [rRows] = await pool.execute(
      'SELECT role_id, permission FROM role_permissions WHERE guild_id = ?',
      [interaction.guildId],
    );
    roleRows = rRows;
  } catch (err) {
    console.error('/config show DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Channels
  const reportId = guildRow?.report_channel_id ? String(guildRow.report_channel_id) : null;
  const modlogDbId = guildRow?.mod_log_channel_id ? String(guildRow.mod_log_channel_id) : null;
  const modlogEnvId = !modlogDbId && process.env.MODLOG_CHANNEL_ID ? process.env.MODLOG_CHANNEL_ID : null;

  const reportLine = reportId ? `<#${reportId}>` : '(nicht konfiguriert)';
  let modlogLine;
  if (modlogDbId) modlogLine = `<#${modlogDbId}>`;
  else if (modlogEnvId) modlogLine = `<#${modlogEnvId}> *(env-Fallback)*`;
  else modlogLine = '(nicht konfiguriert)';

  // Features
  const automodOn = Boolean(guildRow?.automod_enabled);
  const automodLine = automodOn ? '✅ aktiv' : '❌ deaktiviert';

  // Stats
  const nextCase = guildRow?.next_case_number ? `#${Number(guildRow.next_case_number) + 1}` : '#1';

  // Roles (nach Tier gruppiert)
  const byTier = { owner: [], moderator: [], supporter: [] };
  for (const r of roleRows) {
    const rid = String(r.role_id);
    const stillExists = interaction.guild.roles.cache.has(rid);
    const display = stillExists ? `<@&${rid}>` : `<@&${rid}> ⚠️`;
    byTier[r.permission]?.push(display);
  }
  const roleLines = TIER_ORDER
    .map((t) => `**${t.toUpperCase()}**: ${byTier[t].length > 0 ? byTier[t].join(', ') : '—'}`)
    .join('\n');
  const rolesValue = roleRows.length > 0 ? roleLines : '(keine Rollen konfiguriert)';

  const embed = new EmbedBuilder()
    .setTitle('🛡️ Server-Konfiguration')
    .setColor(0x5865f2)
    .addFields(
      { name: '📺 Channels',     value: `Report: ${reportLine}\nMod-Log: ${modlogLine}`, inline: false },
      { name: '⚙️ Features',     value: `Automod: ${automodLine}`,                       inline: false },
      { name: '📊 Statistiken',  value: `Nächste Case-Nr: ${nextCase}`,                  inline: false },
      { name: '🔐 Rollen-Tiers', value: rolesValue,                                       inline: false },
    )
    .setFooter({ text: '🐾 Oreo' });

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
```

- [ ] **Step 4: Syntax-Check**

Run:
```bash
node -c src/commands/config.js
```

Expected: no output.

- [ ] **Step 5: Smoke-Test — `show` ist registriert + `handleShow` ist exportiert über dispatcher**

Run:
```bash
node -e "
const cmd = require('./src/commands/config');
const json = cmd.data.toJSON();
const showSub = json.options.find(o => o.name === 'show' && o.type === 1); // type 1 = SUB_COMMAND
console.log('show subcommand:', showSub ? showSub.name : 'MISSING', '(expected show)');
"
```

Expected: `show subcommand: show (expected show)`.

- [ ] **Step 6: Commit**

```bash
git add src/commands/config.js
git commit -m "feat(commands): add /config show dashboard"
```

---

## Task 5: Migration der 8 Mod-Commands auf `getModLogChannelId`

**Files:**
- Modify: `src/commands/ban.js`
- Modify: `src/commands/kick.js`
- Modify: `src/commands/reason.js`
- Modify: `src/commands/removewarn.js`
- Modify: `src/commands/timeout.js`
- Modify: `src/commands/unban.js`
- Modify: `src/commands/untimeout.js`
- Modify: `src/commands/warn.js`

Ziel: Jede dieser 8 Dateien hat einen Mod-Log-Send-Block, der `process.env.MODLOG_CHANNEL_ID` liest. Alle werden auf `config.getModLogChannelId(interaction.guildId)` mit graceful unconfigured-UX umgestellt.

### Migrations-Pattern

Pro Datei zwei Änderungen:

**Änderung 1:** Import von `config` oben hinzufügen.

Finde die Zeile mit `const cases = require('../cases');` (oder `const config_perms = ...` o.ä., je nach Datei — alle 8 Dateien haben mindestens einen require von '../cases' oder einem anderen lokalen Modul). Direkt darunter (oder direkt nach dem ersten lokalen require) füge ein:

```js
const config = require('../config');
```

**Änderung 2:** Mod-Log-Block ersetzen.

Finde diesen Block (in 7 Dateien — ban.js, kick.js, reason.js, removewarn.js, unban.js, untimeout.js, warn.js — folgt das Pattern mit `try { ... } catch (e) { console.warn('ModLog send failed:', e); ... }`. `timeout.js` hat `(err)` statt `(e)` — check before applying):

old_string:
```js
    try {
      const logChannel = await interaction.client.channels.fetch(process.env.MODLOG_CHANNEL_ID);
```

new_string:
```js
    try {
      const channelId = await config.getModLogChannelId(interaction.guildId);
      if (!channelId) {
        await interaction.followUp({
          content: 'Mod-Log nicht konfiguriert. Admin: `/config channel set type:modlog channel:<#x>` ausführen.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const logChannel = await interaction.client.channels.fetch(channelId);
```

Und finde den catch-Block:

old_string:
```js
        content: 'Mod-Log-Eintrag fehlgeschlagen. Bitte `MODLOG_CHANNEL_ID` prüfen.',
```

new_string:
```js
        content: 'Mod-Log-Eintrag fehlgeschlagen — Channel-Permission oder Channel-ID prüfen.',
```

### Steps

- [ ] **Step 1: `src/commands/ban.js` migrieren**

Apply die zwei Änderungen oben.

Verify nach Edit:
```bash
grep -n "config.getModLogChannelId\|process.env.MODLOG_CHANNEL_ID" src/commands/ban.js
```

Expected: exact one match: `config.getModLogChannelId`. Kein `process.env.MODLOG_CHANNEL_ID` Vorkommen mehr.

- [ ] **Step 2: `src/commands/kick.js` migrieren**

Same pattern as ban.js. Verify same way.

- [ ] **Step 3: `src/commands/reason.js` migrieren**

Same pattern. Verify same way.

- [ ] **Step 4: `src/commands/removewarn.js` migrieren**

Same pattern. Verify same way.

- [ ] **Step 5: `src/commands/timeout.js` migrieren**

Same pattern. Verify same way.

- [ ] **Step 6: `src/commands/unban.js` migrieren**

Same pattern. Verify same way.

- [ ] **Step 7: `src/commands/untimeout.js` migrieren**

Same pattern. Verify same way.

- [ ] **Step 8: `src/commands/warn.js` migrieren**

Same pattern. Verify same way.

- [ ] **Step 9: Globaler Verify — kein env-Vorkommen mehr in den 8 Files**

Run:
```bash
grep -n "process.env.MODLOG_CHANNEL_ID" src/commands/ban.js src/commands/kick.js src/commands/reason.js src/commands/removewarn.js src/commands/timeout.js src/commands/unban.js src/commands/untimeout.js src/commands/warn.js || echo "all clean"
```

Expected: `all clean`.

Und alle 8 nutzen `config.getModLogChannelId`:
```bash
grep -l "config.getModLogChannelId" src/commands/ban.js src/commands/kick.js src/commands/reason.js src/commands/removewarn.js src/commands/timeout.js src/commands/unban.js src/commands/untimeout.js src/commands/warn.js | wc -l
```

Expected: `8`.

- [ ] **Step 10: Syntax-Check für alle acht**

Run:
```bash
node -c src/commands/ban.js && node -c src/commands/kick.js && node -c src/commands/reason.js && node -c src/commands/removewarn.js && node -c src/commands/timeout.js && node -c src/commands/unban.js && node -c src/commands/untimeout.js && node -c src/commands/warn.js
```

Expected: no output.

- [ ] **Step 11: Commit**

```bash
git add src/commands/ban.js src/commands/kick.js src/commands/reason.js src/commands/removewarn.js src/commands/timeout.js src/commands/unban.js src/commands/untimeout.js src/commands/warn.js
git commit -m "feat(commands): migrate mod-log lookup from env to per-guild config"
```

---

## Task 6: Integration-Smoke-Test

**Files:** keine

- [ ] **Step 1: Alle Commands laden + `/config` exposed alle vier Subgroups/Subs**

Run:
```bash
node -e "
const { loadCommands } = require('./src/loadCommands');
const cmds = loadCommands();
console.log('total commands:', cmds.size, '(expected 14)');
const config = cmds.get('config');
const json = config.data.toJSON();
const subs = json.options.map(o => o.type === 1 ? o.name : o.name + '/*');
console.log('config options:', subs.join(', '));
console.log('  (expected: role/*, channel/*, feature/*, show)');
"
```

Expected: `total commands: 14`, options-Liste enthält `role/*`, `channel/*`, `feature/*`, `show`.

- [ ] **Step 2: Bot startet komplett mit allem ohne Crash**

Mit Docker MySQL laufend:

```bash
timeout 15 node --env-file=.env index.js || true
```

Expected: Logs zeigen `MySQL reachable.` → `Schema sichergestellt.` → `Deployed N command(s) to guild <id>` → `Logged in as Oreo#... (14 command(s) loaded)`. Nach 15s killt timeout den Prozess.

Falls `timeout` nicht verfügbar (Windows-natives): nutze `Start-Job` in PowerShell:
```powershell
$job = Start-Job { node --env-file=.env index.js }; Start-Sleep -Seconds 15; Stop-Job $job; Receive-Job $job | Select-Object -First 30; Remove-Job $job -Force
```

- [ ] **Step 3: Smoke-Test gegen Live-MySQL — `/config show` Embed-Build funktioniert**

Write `_smoke_show.js`:

```js
const { getPool } = require('./src/db');
const config = require('./src/config');

(async () => {
  const pool = getPool();
  const guildId = '123456789';

  // Reset + setup
  await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [guildId]);
  await pool.execute(
    'UPDATE guilds SET mod_log_channel_id = ?, report_channel_id = ?, automod_enabled = 1, next_case_number = 41 WHERE guild_id = ?',
    ['111', '222', guildId],
  );
  await pool.execute('DELETE FROM role_permissions WHERE guild_id = ?', [guildId]);
  await pool.execute(
    "INSERT INTO role_permissions (guild_id, role_id, permission) VALUES (?, '333', 'owner'), (?, '444', 'moderator'), (?, '555', 'supporter')",
    [guildId, guildId, guildId],
  );

  // Manuell die SELECTs ausführen, die handleShow macht
  const [[g]] = await pool.execute(
    'SELECT mod_log_channel_id, report_channel_id, automod_enabled, next_case_number FROM guilds WHERE guild_id = ?',
    [guildId],
  );
  const [roles] = await pool.execute('SELECT role_id, permission FROM role_permissions WHERE guild_id = ?', [guildId]);
  console.log('guild row:', g);
  console.log('role rows count:', roles.length, '(expected 3)');

  // Verify config-Reader
  console.log('getModLogChannelId →', await config.getModLogChannelId(guildId), '(expected 111)');
  console.log('getReportChannelId →', await config.getReportChannelId(guildId), '(expected 222)');
  console.log('isAutomodEnabled →',   await config.isAutomodEnabled(guildId), '(expected true)');

  // Cleanup
  await pool.execute('DELETE FROM role_permissions WHERE guild_id = ?', [guildId]);
  await pool.execute('DELETE FROM guilds WHERE guild_id = ?', [guildId]);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
```

Run:
```bash
node --env-file=.env _smoke_show.js
```

Expected (Auszug):
```
role rows count: 3 (expected 3)
getModLogChannelId → 111 (expected 111)
getReportChannelId → 222 (expected 222)
isAutomodEnabled → true (expected true)
```

Cleanup:
```bash
rm _smoke_show.js
```

---

## Task 7: Manuelle E2E-Verifikation in Discord

**Files:** keine

Stage 2b ist deployed (auto-deploy bei Bot-Restart). Folgende Tests in Discord ausführen. Voraussetzung: `/setup` aus Stage 2a wurde bereits einmal ausgeführt, sodass der User owner-tier hat.

- [ ] **Test 1: Frische DB, owner ruft `/config show`**

Erwartung: Embed mit allen Sektionen, Channels "(nicht konfiguriert)" oder env-Fallback, Automod ❌ deaktiviert, next Case-Nr je nach Stand, Rollen-Sektion zeigt die owner-Rolle.

- [ ] **Test 2: `/config channel set type:modlog channel:#mod-log`**

Erwartung: Ephemeral *"Channel `modlog` gesetzt auf <#mod-log>."*.

- [ ] **Test 3: `/config channel set type:modlog channel:<voice-channel>`**

Erwartung: Ephemeral *"Nur Text-Channels werden unterstützt."* — DB unverändert.

Hinweis: Discord blockt Voice-Channels oft schon im Auswahl-Picker via `addChannelTypes(GuildText)`. Falls du es trotzdem schaffst, einen non-text Channel zu picken (Modal-Workaround), greift die Server-side Validation.

- [ ] **Test 4: `/config channel set` auf Channel ohne Bot-SendMessages-Perm**

Vorbereitung: Channel-Permissions des Bot in einem Test-Channel auf "Nachrichten senden = NEIN" setzen, dann `/config channel set type:modlog channel:#test-no-perm`.

Erwartung: Ephemeral *"Mir fehlt die Permission 'Nachrichten senden' in <#…>."* — DB unverändert.

- [ ] **Test 5: `/config channel set type:modlog` auf bereits gesetzten Channel**

Erwartung: Ephemeral *"Channel `modlog` von <#old> auf <#new> geändert."*.

- [ ] **Test 6: `/config channel unset type:modlog`**

Erwartung: Ephemeral *"Channel `modlog` entfernt (war <#x>)."*.

- [ ] **Test 7: `/config channel unset` für nie konfigurierten Channel**

Erwartung: Ephemeral *"Channel `modlog` war nicht konfiguriert — nichts zu tun."*.

- [ ] **Test 8: `/config channel list` mit beiden konfiguriert**

Vorbereitung: Beide Channels via `set` setzen.

Erwartung: Embed zeigt beide mit Mentions.

- [ ] **Test 9: `/config channel list` mit nur env-MODLOG_CHANNEL_ID gesetzt**

Vorbereitung: `unset` für modlog, sodass DB-Wert null und env-Variable greift.

Erwartung: Mod-Log-Zeile zeigt `<#env-id> *(env-Fallback)*`.

- [ ] **Test 10: `/config feature set name:automod value:true`**

Erwartung: Ephemeral mit "aktiviert" + Stub-Warnung *"Automod-Logik ist erst ab Stage 4 …"*.

- [ ] **Test 11: `/config feature set name:automod value:false`**

Erwartung: Ephemeral *"Feature `automod` deaktiviert."* — keine Warnung.

- [ ] **Test 12: `/config show` mit allem konfiguriert**

Erwartung: Embed mit 4 Sektionen (Channels/Features/Stats/Rollen), alles korrekt.

- [ ] **Test 13: `/warn @target` mit gesetztem `mod_log_channel` in DB**

Vorbereitung: `/config channel set type:modlog channel:#mod-log` (anderer als env).

Erwartung: Warn läuft normal, Mod-Log-Embed landet im DB-Channel (NICHT im env-Channel).

- [ ] **Test 14: `/warn @target` ohne DB-Channel aber mit env**

Vorbereitung: `/config channel unset type:modlog` (env bleibt gesetzt).

Erwartung: Warn läuft normal, Mod-Log-Embed landet im env-Channel.

- [ ] **Test 15: `/warn @target` ohne DB-Channel UND ohne env**

Vorbereitung: `/config channel unset type:modlog` + env-Var temporär unsetten (oder zum Test einen falschen Channel als env nehmen).

Erwartung: Warn läuft normal, ephemeraler followUp *"Mod-Log nicht konfiguriert. Admin: `/config channel set type:modlog channel:<#x>` ausführen."*.

- [ ] **Test 16: `/warn @target` mit DB-Channel-ID, die ungültig/gelöscht ist**

Vorbereitung: Manuell in DB: `UPDATE guilds SET mod_log_channel_id = '111111111111' WHERE guild_id = <test_guild>;` (eine nicht-existente Channel-ID).

Erwartung: Warn läuft, ephemeraler followUp *"Mod-Log-Eintrag fehlgeschlagen — Channel-Permission oder Channel-ID prüfen."*.

- [ ] **Test 17: User ohne owner-Tier ruft `/config show`**

Erwartung: Ephemeral *"Du brauchst Tier 'owner' oder höher für diesen Befehl."*.

- [ ] **Step Final: Commit-Marker für Manual-Test-Pass**

```bash
git commit --allow-empty -m "chore: stage 2b manual e2e tests passed (17 scenarios per spec)"
```

---

## Roll-out

Nach allen Tasks:

1. **Push zu origin/main**
   ```bash
   git push origin main
   ```
2. **Auf Server-Host:**
   ```bash
   git pull origin main
   docker compose up -d --build
   ```
3. **Auto-Deploy** registriert neue `/config channel`, `/config feature`, `/config show` Subcommands in Discord.
4. **Keine Pflicht-Aktion** für Server-Owner — env-Fallback hält den Bot funktional. Optionaler Schritt: Owner ruft `/config channel set type:modlog channel:<#x>`, um den env-Wert dauerhaft durch DB-Config zu ersetzen.

**Rollback:** Vorherigen Container-Tag re-deployen. DB bleibt — neue Spalten existieren seit Stage 1.
