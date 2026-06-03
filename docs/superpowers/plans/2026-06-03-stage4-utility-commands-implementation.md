# Stage 4 Utility Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 8 new slash commands — `/cleanup`, `/slowmode`, `/lockdown`, `/unlock` (moderator-tier, destructive with mod-log) and `/userinfo`, `/serverinfo`, `/roleinfo`, `/avatar` (supporter-tier, read-only embeds).

**Architecture:** 8 self-contained command files in `src/commands/`, auto-discovered by `loadCommands.js` (file-glob loader). No new schema. No new modules — each destructive command builds its mod-log embed inline (per Spec §3.5). One DB read in `/userinfo` against existing `infractions` table.

**Tech Stack:** Node.js 20.6+, discord.js v14, mysql2/promise, plain JS, no transpiler. Slash-commands deployed via existing `deployCommands.js` at bot startup. PowerShell on Windows; bot in Docker Compose.

**Spec:** `docs/superpowers/specs/2026-06-03-stage4-utility-commands-design.md`

---

## File Plan

```
NEU (8 files, alle in src/commands/)
├── cleanup.js          (Task 1)
├── slowmode.js         (Task 2)
├── lockdown.js         (Task 3)
├── unlock.js           (Task 3)
├── userinfo.js         (Task 4)
├── serverinfo.js       (Task 5)
├── roleinfo.js         (Task 5)
└── avatar.js           (Task 5)

GEÄNDERT
└── (nichts)
```

**Pre-existing infrastructure (no code changes needed):**
- `src/loadCommands.js` auto-discovers `*.js` in `src/commands/` if file exports `data` + `execute`
- `src/deployCommands.js` registers all loaded commands with Discord at bot startup
- `src/duration.js` exports `parseDuration(str) → ms|null`, `formatDuration(ms) → string`
- `src/config.js` exports `getModLogChannelId(guildId)` (returns null when unconfigured)
- `src/db.js` exports `getPool()`
- Discord.js v14 globals: `SlashCommandBuilder`, `PermissionFlagsBits`, `MessageFlags`, `EmbedBuilder`, `ChannelType`
- Tier-gating is handled by the dispatcher (it reads `module.exports.requiredTier`), so each command file just sets the field

**Task order rationale:**
1. `/cleanup` first — most complex destructive command, sets the mod-log pattern template.
2. `/slowmode` — different destructive shape (duration validation).
3. `/lockdown` + `/unlock` together — mirror commands, idempotency logic shared conceptually.
4. `/userinfo` alone — only command with a DB read, more complex embed.
5. `/serverinfo` + `/roleinfo` + `/avatar` together — three simple read-only embed-only commands.
6. Manual E2E + push.

---

## Task 1: `/cleanup` — Bulk-Message-Delete with Filters

**Files:**
- Create: `src/commands/cleanup.js`

- [ ] **Step 1: Create `src/commands/cleanup.js`**

```js
const { SlashCommandBuilder, MessageFlags, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cleanup')
    .setDescription('Löscht die letzten N Messages (optional gefiltert).')
    .addIntegerOption((o) => o.setName('amount').setDescription('Anzahl Messages (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
    .addUserOption((o) => o.setName('user').setDescription('Nur Messages von diesem User').setRequired(false))
    .addStringOption((o) => o.setName('contains').setDescription('Nur Messages die diesen Text enthalten').setRequired(false))
    .addBooleanOption((o) => o.setName('bots_only').setDescription('Nur Bot-Messages').setRequired(false)),

  requiredTier: 'moderator',

  async execute(interaction) {
    const channel = interaction.channel;

    // Channel-type guard
    if (!channel?.isTextBased() || channel.isDMBased()) {
      return interaction.reply({ content: '❌ Nur Text-Channels.', flags: MessageFlags.Ephemeral });
    }

    // Bot-permission guard
    const botPerms = channel.permissionsFor(interaction.guild.members.me);
    if (!botPerms?.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({
        content: `❌ Mir fehlt die Permission \`ManageMessages\` in <#${channel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const amount = interaction.options.getInteger('amount');
    const userFilter = interaction.options.getUser('user');
    const containsFilter = interaction.options.getString('contains');
    const botsOnly = interaction.options.getBoolean('bots_only') ?? false;

    let fetched;
    try {
      fetched = await channel.messages.fetch({ limit: amount });
    } catch (err) {
      console.warn('/cleanup fetch failed:', err);
      return interaction.reply({
        content: `❌ Messages konnten nicht abgerufen werden: ${err.code ?? err.message ?? 'unbekannt'}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const filtered = [...fetched.values()].filter((m) => {
      if (userFilter && m.author.id !== userFilter.id) return false;
      if (containsFilter && !m.content?.toLowerCase().includes(containsFilter.toLowerCase())) return false;
      if (botsOnly && !m.author.bot) return false;
      if (now - m.createdTimestamp > FOURTEEN_DAYS_MS) return false;
      return true;
    });

    if (filtered.length === 0) {
      return interaction.reply({
        content: `⚠️ Keine Messages matchen den Filter (von ${fetched.size} geprüften).`,
        flags: MessageFlags.Ephemeral,
      });
    }

    let deleted;
    try {
      const deletedCollection = await channel.bulkDelete(filtered, true);
      deleted = deletedCollection.size;
    } catch (err) {
      console.warn('/cleanup bulkDelete failed:', err);
      return interaction.reply({
        content: `❌ Aktion fehlgeschlagen: ${err.code ?? err.message ?? 'unbekannter Fehler'}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const skipped = filtered.length - deleted;
    const replyMessage = skipped > 0
      ? `✅ ${deleted} Messages gelöscht. (${skipped} waren älter als 14 Tage und wurden übersprungen)`
      : `✅ ${deleted} Messages gelöscht.`;
    await interaction.reply({ content: replyMessage, flags: MessageFlags.Ephemeral });

    // Mod-Log-Embed (fail-soft, inline)
    try {
      const modLogChannelId = await config.getModLogChannelId(interaction.guildId);
      if (modLogChannelId) {
        const modLogChannel = await interaction.client.channels.fetch(modLogChannelId);
        if (modLogChannel) {
          const filterParts = [];
          if (userFilter) filterParts.push(`user=<@${userFilter.id}>`);
          if (containsFilter) filterParts.push(`contains="${containsFilter}"`);
          if (botsOnly) filterParts.push('bots_only');

          const embed = new EmbedBuilder()
            .setTitle('🧹 Cleanup')
            .setColor(0x5865f2)
            .addFields(
              { name: '🛡️ Moderator', value: `<@${interaction.user.id}>`, inline: true },
              { name: '📺 Channel', value: `<#${channel.id}>`, inline: true },
              { name: '🗑️ Gelöscht', value: `${deleted} Messages`, inline: false },
            );
          if (filterParts.length > 0) {
            embed.addFields({ name: '🔍 Filter', value: filterParts.join(', '), inline: false });
          }
          embed.setFooter({ text: '🐾 Oreo' }).setTimestamp();
          await modLogChannel.send({ embeds: [embed] });
        }
      }
    } catch (err) {
      console.warn('[cleanup] modlog post failed:', err);
    }
  },
};
```

- [ ] **Step 2: Smoke-load the new command**

```powershell
node --env-file=.env -e "const c = require('./src/commands/cleanup'); console.log('cleanup:', typeof c.execute, typeof c.data, c.requiredTier);"
```

Expected: `cleanup: function object moderator`. No syntax errors.

- [ ] **Step 3: Run existing smoke tests (regression check)**

```powershell
node tests/smoke/modlog.js
node --env-file=.env tests/smoke/duration.js
node --env-file=.env tests/smoke/reports.js
node --env-file=.env tests/smoke/escalations.js
```

Expected: all four exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/commands/cleanup.js
git commit -m "$(cat <<'EOF'
feat(cleanup): /cleanup bulk message delete with filters

Slash command for moderator-tier:
  /cleanup amount:<1-100> [user:@X] [contains:<text>] [bots_only:true]

Filtert client-side, bulkDelete (max 100, <14d), fail-soft mod-log.
Reply zeigt geloeschte + ggf. skip-count fuer >14d.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `/slowmode` — Channel-Slowmode Setter

**Files:**
- Create: `src/commands/slowmode.js`

- [ ] **Step 1: Create `src/commands/slowmode.js`**

```js
const { SlashCommandBuilder, MessageFlags, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const { parseDuration, formatDuration } = require('../duration');

const MAX_SLOWMODE_MS = 6 * 60 * 60 * 1000; // Discord-Limit: 6 hours

module.exports = {
  data: new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Setzt den Slowmode des aktuellen Channels.')
    .addStringOption((o) => o.setName('duration').setDescription('Dauer (0s = aus, max 6h) — z.B. 30s, 5m, 1h').setRequired(true)),

  requiredTier: 'moderator',

  async execute(interaction) {
    const channel = interaction.channel;

    if (!channel?.isTextBased() || channel.isDMBased()) {
      return interaction.reply({ content: '❌ Nur Text-Channels.', flags: MessageFlags.Ephemeral });
    }

    const botPerms = channel.permissionsFor(interaction.guild.members.me);
    if (!botPerms?.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.reply({
        content: `❌ Mir fehlt die Permission \`ManageChannels\` in <#${channel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const durationInput = interaction.options.getString('duration');
    const durationMs = parseDuration(durationInput);

    if (durationMs == null) {
      return interaction.reply({ content: '❌ Ungültige Dauer-Angabe.', flags: MessageFlags.Ephemeral });
    }
    if (durationMs > MAX_SLOWMODE_MS) {
      return interaction.reply({ content: '❌ Max. Slowmode ist 6 Stunden.', flags: MessageFlags.Ephemeral });
    }

    const seconds = Math.floor(durationMs / 1000);

    try {
      await channel.setRateLimitPerUser(seconds);
    } catch (err) {
      console.warn('/slowmode action failed:', err);
      return interaction.reply({
        content: `❌ Aktion fehlgeschlagen: ${err.code ?? err.message ?? 'unbekannter Fehler'}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const replyMessage = seconds > 0
      ? `✅ Slowmode auf ${formatDuration(durationMs)} gesetzt.`
      : '✅ Slowmode deaktiviert.';
    await interaction.reply({ content: replyMessage, flags: MessageFlags.Ephemeral });

    // Mod-Log-Embed (fail-soft)
    try {
      const modLogChannelId = await config.getModLogChannelId(interaction.guildId);
      if (modLogChannelId) {
        const modLogChannel = await interaction.client.channels.fetch(modLogChannelId);
        if (modLogChannel) {
          const embed = new EmbedBuilder()
            .setTitle('⏳ Slowmode')
            .setColor(0x5865f2)
            .addFields(
              { name: '🛡️ Moderator', value: `<@${interaction.user.id}>`, inline: true },
              { name: '📺 Channel', value: `<#${channel.id}>`, inline: true },
              { name: '⏱️ Neue Dauer', value: seconds > 0 ? formatDuration(durationMs) : 'deaktiviert', inline: false },
            )
            .setFooter({ text: '🐾 Oreo' })
            .setTimestamp();
          await modLogChannel.send({ embeds: [embed] });
        }
      }
    } catch (err) {
      console.warn('[slowmode] modlog post failed:', err);
    }
  },
};
```

- [ ] **Step 2: Smoke-load**

```powershell
node --env-file=.env -e "const c = require('./src/commands/slowmode'); console.log('slowmode:', typeof c.execute, typeof c.data, c.requiredTier);"
```

Expected: `slowmode: function object moderator`.

- [ ] **Step 3: Run all existing smoke tests**

```powershell
node tests/smoke/modlog.js
node --env-file=.env tests/smoke/duration.js
node --env-file=.env tests/smoke/reports.js
node --env-file=.env tests/smoke/escalations.js
```

Expected: all four exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/commands/slowmode.js
git commit -m "$(cat <<'EOF'
feat(slowmode): /slowmode channel slowmode setter

Slash command for moderator-tier:
  /slowmode duration:<X>

parseDuration aus src/duration.js, 0s = off, max 6h (Discord-Limit).
setRateLimitPerUser(seconds), fail-soft mod-log embed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `/lockdown` + `/unlock` — Channel Lock/Unlock (Mirror Pair)

**Files:**
- Create: `src/commands/lockdown.js`
- Create: `src/commands/unlock.js`

- [ ] **Step 1: Create `src/commands/lockdown.js`**

```js
const { SlashCommandBuilder, MessageFlags, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Sperrt den aktuellen Channel für @everyone (deny SendMessages).'),

  requiredTier: 'moderator',

  async execute(interaction) {
    const channel = interaction.channel;
    const guild = interaction.guild;

    if (!channel?.isTextBased() || channel.isDMBased()) {
      return interaction.reply({ content: '❌ Nur Text-Channels.', flags: MessageFlags.Ephemeral });
    }

    const botPerms = channel.permissionsFor(guild.members.me);
    if (!botPerms?.has([PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels])) {
      return interaction.reply({
        content: `❌ Mir fehlen die Permissions \`ManageRoles\` oder \`ManageChannels\` in <#${channel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const everyone = guild.roles.everyone;
    const currentOverwrite = channel.permissionOverwrites.cache.get(everyone.id);
    const alreadyLocked = currentOverwrite?.deny?.has(PermissionFlagsBits.SendMessages) ?? false;

    if (alreadyLocked) {
      return interaction.reply({ content: 'Channel ist bereits gesperrt.', flags: MessageFlags.Ephemeral });
    }

    try {
      await channel.permissionOverwrites.edit(everyone, { SendMessages: false });
    } catch (err) {
      console.warn('/lockdown action failed:', err);
      return interaction.reply({
        content: `❌ Aktion fehlgeschlagen: ${err.code ?? err.message ?? 'unbekannter Fehler'}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.reply({ content: '🔒 Channel gesperrt.', flags: MessageFlags.Ephemeral });

    // Mod-Log-Embed (fail-soft)
    try {
      const modLogChannelId = await config.getModLogChannelId(interaction.guildId);
      if (modLogChannelId) {
        const modLogChannel = await interaction.client.channels.fetch(modLogChannelId);
        if (modLogChannel) {
          const embed = new EmbedBuilder()
            .setTitle('🔒 Lockdown')
            .setColor(0x5865f2)
            .addFields(
              { name: '🛡️ Moderator', value: `<@${interaction.user.id}>`, inline: true },
              { name: '📺 Channel', value: `<#${channel.id}>`, inline: true },
            )
            .setFooter({ text: '🐾 Oreo' })
            .setTimestamp();
          await modLogChannel.send({ embeds: [embed] });
        }
      }
    } catch (err) {
      console.warn('[lockdown] modlog post failed:', err);
    }
  },
};
```

- [ ] **Step 2: Create `src/commands/unlock.js`**

```js
const { SlashCommandBuilder, MessageFlags, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Entsperrt den aktuellen Channel (clear @everyone SendMessages override).'),

  requiredTier: 'moderator',

  async execute(interaction) {
    const channel = interaction.channel;
    const guild = interaction.guild;

    if (!channel?.isTextBased() || channel.isDMBased()) {
      return interaction.reply({ content: '❌ Nur Text-Channels.', flags: MessageFlags.Ephemeral });
    }

    const botPerms = channel.permissionsFor(guild.members.me);
    if (!botPerms?.has([PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels])) {
      return interaction.reply({
        content: `❌ Mir fehlen die Permissions \`ManageRoles\` oder \`ManageChannels\` in <#${channel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const everyone = guild.roles.everyone;
    const currentOverwrite = channel.permissionOverwrites.cache.get(everyone.id);
    const isLocked = currentOverwrite?.deny?.has(PermissionFlagsBits.SendMessages) ?? false;

    if (!isLocked) {
      return interaction.reply({ content: 'Channel ist nicht gesperrt.', flags: MessageFlags.Ephemeral });
    }

    try {
      await channel.permissionOverwrites.edit(everyone, { SendMessages: null });
    } catch (err) {
      console.warn('/unlock action failed:', err);
      return interaction.reply({
        content: `❌ Aktion fehlgeschlagen: ${err.code ?? err.message ?? 'unbekannter Fehler'}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.reply({ content: '🔓 Channel entsperrt.', flags: MessageFlags.Ephemeral });

    // Mod-Log-Embed (fail-soft)
    try {
      const modLogChannelId = await config.getModLogChannelId(interaction.guildId);
      if (modLogChannelId) {
        const modLogChannel = await interaction.client.channels.fetch(modLogChannelId);
        if (modLogChannel) {
          const embed = new EmbedBuilder()
            .setTitle('🔓 Unlock')
            .setColor(0x5865f2)
            .addFields(
              { name: '🛡️ Moderator', value: `<@${interaction.user.id}>`, inline: true },
              { name: '📺 Channel', value: `<#${channel.id}>`, inline: true },
            )
            .setFooter({ text: '🐾 Oreo' })
            .setTimestamp();
          await modLogChannel.send({ embeds: [embed] });
        }
      }
    } catch (err) {
      console.warn('[unlock] modlog post failed:', err);
    }
  },
};
```

- [ ] **Step 3: Smoke-load both**

```powershell
node --env-file=.env -e "['lockdown','unlock'].forEach(n => { const c = require('./src/commands/' + n); console.log(n, typeof c.execute, typeof c.data, c.requiredTier); })"
```

Expected: 2 lines `lockdown function object moderator` + `unlock function object moderator`.

- [ ] **Step 4: Run all existing smoke tests**

```powershell
node tests/smoke/modlog.js
node --env-file=.env tests/smoke/duration.js
node --env-file=.env tests/smoke/reports.js
node --env-file=.env tests/smoke/escalations.js
```

Expected: all four exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/commands/lockdown.js src/commands/unlock.js
git commit -m "$(cat <<'EOF'
feat(lockdown): /lockdown + /unlock channel lock pair

Mirror commands for moderator-tier:
  /lockdown — set @everyone SendMessages = false override
  /unlock   — clear @everyone SendMessages override (null = inherit)

Idempotent: skip mit "bereits gesperrt"/"nicht gesperrt" wenn schon
in target state. Fail-soft mod-log embeds (🔒 / 🔓 Title).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `/userinfo` — Full Mod-Context User Lookup

**Files:**
- Create: `src/commands/userinfo.js`

This is the only command with a DB read. The query aggregates infraction counts in one round-trip.

- [ ] **Step 1: Create `src/commands/userinfo.js`**

```js
const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { getPool } = require('../db');

const MAX_ROLES_DISPLAYED = 10;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Zeigt Informationen über einen User (Account, Server, Cases).')
    .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),

  requiredTier: 'supporter',

  async execute(interaction) {
    const user = interaction.options.getUser('user');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    // DB-Query: aggregate case counts by type + active
    let caseStats = { warnActive: 0, warnTotal: 0, timeoutTotal: 0, kickTotal: 0, banTotal: 0 };
    try {
      const [rows] = await getPool().execute(
        `SELECT type, active, COUNT(*) AS count
           FROM infractions
          WHERE guild_id = ? AND user_id = ?
          GROUP BY type, active`,
        [interaction.guildId, user.id],
      );
      for (const row of rows) {
        const count = Number(row.count);
        if (row.type === 'warn') {
          caseStats.warnTotal += count;
          if (row.active) caseStats.warnActive += count;
        } else if (row.type === 'timeout') {
          caseStats.timeoutTotal += count;
        } else if (row.type === 'kick') {
          caseStats.kickTotal += count;
        } else if (row.type === 'ban') {
          caseStats.banTotal += count;
        }
      }
    } catch (err) {
      console.error('/userinfo DB error:', err);
      return interaction.reply({
        content: 'Datenbankfehler — versuch es später.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const createdSec = Math.floor(user.createdTimestamp / 1000);

    // Roles field (only if member)
    let rolesValue = '—';
    if (member) {
      const roles = member.roles.cache
        .filter((r) => r.id !== interaction.guildId) // exclude @everyone
        .sort((a, b) => b.position - a.position)
        .map((r) => `<@&${r.id}>`);
      if (roles.length === 0) {
        rolesValue = '—';
      } else if (roles.length <= MAX_ROLES_DISPLAYED) {
        rolesValue = roles.join(', ');
      } else {
        rolesValue = `${roles.slice(0, MAX_ROLES_DISPLAYED).join(', ')} (+${roles.length - MAX_ROLES_DISPLAYED} weitere)`;
      }
    }

    // Server-join field
    let joinValue;
    if (member?.joinedTimestamp) {
      const joinedSec = Math.floor(member.joinedTimestamp / 1000);
      joinValue = `<t:${joinedSec}:f> (<t:${joinedSec}:R>)`;
    } else {
      joinValue = 'nicht auf dem Server';
    }

    // Cases field (multi-line)
    const casesValue = [
      `⚠️ Warns: ${caseStats.warnTotal} (${caseStats.warnActive} aktiv)`,
      `⏱️ Timeouts: ${caseStats.timeoutTotal}`,
      `👢 Kicks: ${caseStats.kickTotal}`,
      `🔨 Bans: ${caseStats.banTotal}`,
    ].join('\n');

    const embed = new EmbedBuilder()
      .setTitle(`👤 ${user.tag}`)
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .setColor(0x5865f2)
      .addFields(
        { name: '🆔 User-ID', value: user.id, inline: true },
        { name: '📅 Account erstellt', value: `<t:${createdSec}:f> (<t:${createdSec}:R>)`, inline: true },
        { name: '🚪 Server-Beitritt', value: joinValue, inline: true },
        { name: '🎭 Rollen', value: rolesValue, inline: false },
        { name: '⚖️ Cases', value: casesValue, inline: false },
      )
      .setFooter({ text: '🐾 Oreo' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
```

- [ ] **Step 2: Smoke-load**

```powershell
node --env-file=.env -e "const c = require('./src/commands/userinfo'); console.log('userinfo:', typeof c.execute, typeof c.data, c.requiredTier);"
```

Expected: `userinfo: function object supporter`.

- [ ] **Step 3: Run all existing smoke tests**

```powershell
node tests/smoke/modlog.js
node --env-file=.env tests/smoke/duration.js
node --env-file=.env tests/smoke/reports.js
node --env-file=.env tests/smoke/escalations.js
```

Expected: all four exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/commands/userinfo.js
git commit -m "$(cat <<'EOF'
feat(userinfo): /userinfo full mod-context user lookup

Slash command for supporter-tier:
  /userinfo user:@X

Embed mit Account-Created, Server-Joined, Top-10-Rollen, Case-Stats
(Warns aktiv/total, Timeouts, Kicks, Bans) via einer GROUP BY query
auf infractions. Fail-soft bei member.fetch (User nicht im Server).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `/serverinfo` + `/roleinfo` + `/avatar` — Simple Read-Only Embeds

**Files:**
- Create: `src/commands/serverinfo.js`
- Create: `src/commands/roleinfo.js`
- Create: `src/commands/avatar.js`

Three small commands grouped — all simple Discord-data embeds, no DB, no Discord state changes.

- [ ] **Step 1: Create `src/commands/serverinfo.js`**

```js
const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');

const PREMIUM_TIER_LABELS = {
  NONE: 'NONE',
  TIER_1: 'TIER_1',
  TIER_2: 'TIER_2',
  TIER_3: 'TIER_3',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('Zeigt Informationen über diesen Server.'),

  requiredTier: 'supporter',

  async execute(interaction) {
    const guild = interaction.guild;
    const createdSec = Math.floor(guild.createdTimestamp / 1000);
    const memberCount = guild.memberCount;
    const channelCount = guild.channels.cache.size;
    const roleCount = guild.roles.cache.size - 1; // exclude @everyone
    const boostCount = guild.premiumSubscriptionCount ?? 0;
    const boostTier = PREMIUM_TIER_LABELS[guild.premiumTier] ?? String(guild.premiumTier);

    const embed = new EmbedBuilder()
      .setTitle(`🛡️ ${guild.name}`)
      .setColor(0x5865f2)
      .addFields(
        { name: '🆔 Guild-ID', value: guild.id, inline: true },
        { name: '👑 Owner', value: `<@${guild.ownerId}>`, inline: true },
        { name: '📅 Erstellt', value: `<t:${createdSec}:f> (<t:${createdSec}:R>)`, inline: true },
        { name: '👥 Members', value: String(memberCount), inline: true },
        { name: '📺 Channels', value: String(channelCount), inline: true },
        { name: '🎭 Rollen', value: String(roleCount), inline: true },
        { name: '🚀 Boost', value: `${boostCount} Boosts (Tier ${boostTier})`, inline: false },
      )
      .setFooter({ text: '🐾 Oreo' })
      .setTimestamp();

    const iconURL = guild.iconURL({ size: 256 });
    if (iconURL) embed.setThumbnail(iconURL);

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
```

- [ ] **Step 2: Create `src/commands/roleinfo.js`**

```js
const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('roleinfo')
    .setDescription('Zeigt Informationen über eine Rolle.')
    .addRoleOption((o) => o.setName('role').setDescription('Rolle').setRequired(true)),

  requiredTier: 'supporter',

  async execute(interaction) {
    const role = interaction.options.getRole('role');
    const createdSec = Math.floor(role.createdTimestamp / 1000);
    const memberCount = role.members.size;
    const colorHex = role.color === 0
      ? 'keine'
      : `#${role.color.toString(16).padStart(6, '0')}`;

    const embed = new EmbedBuilder()
      .setTitle(`🎭 ${role.name}`)
      .setColor(role.color || 0x5865f2)
      .addFields(
        { name: '🆔 Role-ID', value: role.id, inline: true },
        { name: '🎨 Farbe', value: colorHex, inline: true },
        { name: '📅 Erstellt', value: `<t:${createdSec}:f> (<t:${createdSec}:R>)`, inline: true },
        { name: '👥 Members', value: String(memberCount), inline: true },
        { name: '📌 Hoisted', value: role.hoist ? 'ja' : 'nein', inline: true },
        { name: '🔔 Mentionable', value: role.mentionable ? 'ja' : 'nein', inline: true },
        { name: '🤖 Managed', value: role.managed ? 'ja (bot/integration)' : 'nein', inline: true },
      )
      .setFooter({ text: '🐾 Oreo' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
```

- [ ] **Step 3: Create `src/commands/avatar.js`**

```js
const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('avatar')
    .setDescription('Zeigt den Avatar eines Users in voller Größe.')
    .addUserOption((o) => o.setName('user').setDescription('User (default: du selbst)').setRequired(false)),

  requiredTier: 'supporter',

  async execute(interaction) {
    const user = interaction.options.getUser('user') ?? interaction.user;
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    const userAvatarUrl = user.displayAvatarURL({ size: 4096 });
    let imageUrl = userAvatarUrl;
    let descriptionLine = null;

    if (member && member.avatar) {
      // Member has server-specific avatar
      const memberAvatarUrl = member.displayAvatarURL({ size: 4096 });
      if (memberAvatarUrl !== userAvatarUrl) {
        imageUrl = memberAvatarUrl;
        descriptionLine = `[User-Avatar (global)](${userAvatarUrl})`;
      }
    }

    const embed = new EmbedBuilder()
      .setTitle(`🖼️ Avatar von ${user.tag}`)
      .setImage(imageUrl)
      .setColor(0x5865f2)
      .setFooter({ text: '🐾 Oreo' })
      .setTimestamp();

    if (descriptionLine) embed.setDescription(descriptionLine);

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
```

- [ ] **Step 4: Smoke-load all three**

```powershell
node --env-file=.env -e "['serverinfo','roleinfo','avatar'].forEach(n => { const c = require('./src/commands/' + n); console.log(n, typeof c.execute, typeof c.data, c.requiredTier); })"
```

Expected: 3 lines with `function object supporter`.

- [ ] **Step 5: Run all existing smoke tests**

```powershell
node tests/smoke/modlog.js
node --env-file=.env tests/smoke/duration.js
node --env-file=.env tests/smoke/reports.js
node --env-file=.env tests/smoke/escalations.js
```

Expected: all four exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/commands/serverinfo.js src/commands/roleinfo.js src/commands/avatar.js
git commit -m "$(cat <<'EOF'
feat(info): /serverinfo + /roleinfo + /avatar read-only embeds

Three supporter-tier read-only lookup commands:
  /serverinfo                — Guild stats (members, channels, owner, boost)
  /roleinfo role:@X          — Role color, member count, flags
  /avatar [user:@X]          — Voller Avatar im Embed; bei Member-spezifischem
                                Avatar zusaetzlich Link zum globalen

Alle ephemeral, kein DB-Access, kein Discord-State-Change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Manual E2E + Push

**No code changes.** Pure verification step + push.

- [ ] **Step 1: Confirm clean working tree**

```powershell
git -C "c:/Users/Lukas/Documents/Oreo" status
```

Expected: nothing to commit, working tree clean.

- [ ] **Step 2: Restart bot to deploy new commands**

The slash-builder structure now includes 8 new commands. Discord needs the new structure pushed via the bot's startup redeploy.

```powershell
docker compose --project-directory "c:/Users/Lukas/Documents/Oreo" restart bot
docker compose --project-directory "c:/Users/Lukas/Documents/Oreo" logs bot --tail 30
```

Expected log lines:
- `Deployed N command(s) to guild ...` where N = previous count + 8 (was 15, should now be 23)
- `Logged in as Oreo#...`

If the count didn't go up by 8, one of the new command files isn't loading. Check the bot log for `[commands] skipping ...` warnings — that points at a missing `data` or `execute` export.

- [ ] **Step 3: Manual E2E checklist**

Work through the checklist in `docs/superpowers/specs/2026-06-03-stage4-utility-commands-design.md` §6.2.

**Setup:**
- Test-Guild mit Mod-Log konfiguriert
- Owner + Moderator + Supporter + Member Accounts
- Bot mit `ManageMessages`, `ManageChannels`, `ManageRoles` Permissions
- Test-Channel mit ≥30 Messages (mix User + Bot)

**Permission-Gating (P1–P3):**
- [ ] **P1** Supporter ruft `/cleanup amount:5` → ❌ Permission denied
- [ ] **P2** Member ruft `/userinfo user:@x` → ❌ Permission denied
- [ ] **P3** Owner ruft `/lockdown` → ✅ allowed

**/cleanup (CL1–CL6):**
- [ ] **CL1** `/cleanup amount:5` → 5 Messages weg, Reply ✅, Mod-Log 🧹
- [ ] **CL2** `/cleanup amount:10 user:@member` → nur Member-Msgs, Mod-Log mit Filter
- [ ] **CL3** `/cleanup amount:20 bots_only:true` → nur Bot-Msgs
- [ ] **CL4** `/cleanup amount:5 contains:test` → nur Messages mit "test" (case-insensitive)
- [ ] **CL5** `/cleanup amount:100` in Channel mit >14d Messages → Reply zeigt skip-count
- [ ] **CL6** `/cleanup amount:5 user:@nicht_existierend` → ⚠️ "Keine Messages matchen den Filter", kein Mod-Log

**/slowmode (SM1–SM4):**
- [ ] **SM1** `/slowmode duration:30s` → Slowmode 30s, Reply ✅, Mod-Log ⏳
- [ ] **SM2** `/slowmode duration:0s` → off, Reply "deaktiviert"
- [ ] **SM3** `/slowmode duration:7h` → ❌ "Max. Slowmode ist 6 Stunden"
- [ ] **SM4** `/slowmode duration:garbage` → ❌ "Ungültige Dauer-Angabe"

**/lockdown + /unlock (LK1–LK5):**
- [ ] **LK1** `/lockdown` in offenem Channel → 🔒, Mod-Log
- [ ] **LK2** `/lockdown` in bereits gesperrtem → "bereits gesperrt", kein Mod-Log
- [ ] **LK3** `/unlock` in gesperrtem → 🔓, Mod-Log
- [ ] **LK4** `/unlock` in offenem → "nicht gesperrt", kein Mod-Log
- [ ] **LK5** Bei Lockdown: Member kann keine Messages senden

**/userinfo (UI1–UI4):**
- [ ] **UI1** `/userinfo user:@member` (keine Cases) → Embed, Cases alle 0
- [ ] **UI2** `/userinfo user:@member` nach `/warn` + `/timeout` → Warns 1 (1 aktiv), Timeouts 1
- [ ] **UI3** `/userinfo user:<ID nicht-im-Server>` → "nicht auf dem Server"
- [ ] **UI4** `/userinfo user:@bot` → funktioniert

**/serverinfo + /roleinfo + /avatar (IF1–IF4):**
- [ ] **IF1** `/serverinfo` → Embed mit allen Stats
- [ ] **IF2** `/roleinfo role:@some_role` → Embed mit Color, Members, Flags
- [ ] **IF3** `/avatar` (ohne user) → eigener Avatar
- [ ] **IF4** `/avatar user:@x` mit Server-spezifischem Avatar → Member-Avatar als Image, Global-Link in Description

**Out-of-Scope-Verifikation (X1–X3):**
- [ ] **X1** Read-only commands posten KEIN Mod-Log
- [ ] **X2** Read-only commands ändern KEINEN Discord-State
- [ ] **X3** Bot ohne `ManageMessages` → `/cleanup` schlägt mit Permission-Error ab

- [ ] **Step 4: Push**

```powershell
git -C "c:/Users/Lukas/Documents/Oreo" push origin main
```

Expected: 5 Stage-4 implementation commits land on origin (Task 1-5 commits) plus the plan's own commit when written.

---

## Out-of-Scope Reminders (do NOT do these in this plan)

Per Spec §1 and §8:

- No `/nuke`, `/say`, `/embed`, `/poll`, `/remindme`, `/note`, `/channel-clone`, `/voice-move`, `/role-give-many`
- No per-command-tier-override configuration
- No `/cleanup amount > 100`
- No `/lockdown reason` with channel-topic backup
- No multi-channel-lockdown (always current channel)
- No extending `src/modlog.js` `buildModLogEmbed` for utility actions (stays inline per Spec §3.5)
- No new schema, no new top-level module
- No `mod_notes` table
- No automated smoke tests (Discord-heavy, manual E2E only)

---

## Self-Review Trace

**Spec coverage:**
| Spec section | Task | Covered? |
|---|---|---|
| §1 Ziel & Scope | Tasks 1–6 | ✓ |
| §2 Modul-Layout | All tasks (8 files created, kein neues Modul) | ✓ |
| §3.1 /cleanup | Task 1 | ✓ |
| §3.2 /slowmode | Task 2 | ✓ |
| §3.3 /lockdown | Task 3 Step 1 | ✓ |
| §3.4 /unlock | Task 3 Step 2 | ✓ |
| §3.5 Mod-Log-Embed Pattern (inline) | Tasks 1, 2, 3 (inline in each command) | ✓ |
| §4.1 /userinfo | Task 4 | ✓ |
| §4.2 /serverinfo | Task 5 Step 1 | ✓ |
| §4.3 /roleinfo | Task 5 Step 2 | ✓ |
| §4.4 /avatar | Task 5 Step 3 | ✓ |
| §4.5 Read-only Eigenschaften (ephemeral, kein modlog) | Tasks 4, 5 (alle replies ephemeral) | ✓ |
| §5.1 Bot-Permission-Checks | Tasks 1, 2, 3 (jeweils im execute-Anfang) | ✓ |
| §5.2 Channel-Type-Check | Tasks 1, 2, 3 (jeweils im execute-Anfang) | ✓ |
| §5.3 Discord-API-Failure-Pattern | Tasks 1, 2, 3 (try/catch um die API-Calls) | ✓ |
| §5.4 /cleanup Edge-Cases | Task 1 (0-matches branch, >14d filter, skip-count) | ✓ |
| §5.5 /lockdown + /unlock Idempotenz | Task 3 (alreadyLocked / isLocked checks) | ✓ |
| §5.6 /slowmode Edge-Cases | Task 2 (null check, max check) | ✓ |
| §5.7 Read-only Failure | Task 4 (DB error catch); Tasks 5 (display-only, kein failure-path) | ✓ |
| §6.1 Smoke-Test (Module-Load-Check) | Tasks 1-5 Step 2 (per task) | ✓ |
| §6.2 Manuelle E2E | Task 6 Step 3 | ✓ |
| §7 Rollback | Implicit (additive only) | ✓ |
| §8 Open Questions | Out-of-scope list above | n/a |

**Placeholder scan:**
- No "TBD" / "TODO" / "implement later"
- No "add error handling" without specifics
- Every step has concrete code or exact PowerShell command
- "Similar to Task N" never used — each task has its full code shown

**Type/identifier consistency:**
- `requiredTier: 'moderator'` — Tasks 1, 2, 3 (4 commands)
- `requiredTier: 'supporter'` — Tasks 4, 5 (4 commands)
- `MessageFlags.Ephemeral` — every reply uses this constant
- `0x5865f2` (blurple) — Tasks 1, 2, 3, 5 (mod-log + read-only embeds)
- `PermissionFlagsBits.ManageMessages` / `ManageChannels` / `ManageRoles` / `SendMessages` — consistent naming
- `config.getModLogChannelId(interaction.guildId)` — Tasks 1, 2, 3 (all 4 destructive commands)
- `parseDuration(input)` returns `ms-or-null` — Task 2 expects this contract
- `formatDuration(ms)` returns formatted German string — Task 2 uses this for reply + embed
- Embed-titles: `🧹 Cleanup`, `⏳ Slowmode`, `🔒 Lockdown`, `🔓 Unlock` (destructive); `👤 ${tag}`, `🛡️ ${name}`, `🎭 ${name}`, `🖼️ Avatar von ${tag}` (read-only) — all consistent with spec §3.5 + §4.x
