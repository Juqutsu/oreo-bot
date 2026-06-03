# Stage 4b `/announcement` Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `/announcement` — moderator-tier slash command that opens a Discord-Modal (Title + Description), submit → bot posts an embed (blurple) in the chosen channel with optional Role-ping prefix, mod-log captures the action.

**Architecture:** Two files: `src/commands/announcement.js` (slash-builder + modal-show) and `src/interactions/announcement.js` (modal-submit handler with `dispatch(interaction)` API mirroring `src/interactions/report.js`). `index.js` Dispatcher-Chain wird um `announcementInteractions.dispatch` erweitert. State zwischen Slash und Modal-Submit floats via customId `announcement:modal:<channelId>:<roleId|none>`. Race-Protection: alle Validations werden im Submit-Handler wiederholt.

**Tech Stack:** Node.js 20.6+, discord.js v14 (`ModalBuilder`, `TextInputBuilder`, `ActionRowBuilder`), no DB, no schema change. PowerShell on Windows; bot in Docker Compose.

**Spec:** `docs/superpowers/specs/2026-06-03-stage4b-announcement-command-design.md`

---

## File Plan

```
NEU
├── src/commands/announcement.js                    (Task 1, ~70 LoC)
└── src/interactions/announcement.js                (Task 2, ~110 LoC)

GEÄNDERT
└── index.js                                        (Task 3, +2 LoC dispatcher-chain)
```

**Pre-existing infrastructure (no code changes needed):**
- `src/loadCommands.js` auto-discovers `src/commands/*.js` files
- `src/deployCommands.js` registers all loaded commands at bot startup
- `src/config.js` exports `getModLogChannelId(guildId)` (returns null when unconfigured)
- `index.js` already has component-dispatch block (line 83) for button/select/modal interactions
- `src/interactions/report.js` provides the `dispatch(interaction)` boolean-return pattern (line 32)

**Task order rationale:**
1. Slash + Modal-Show first — the user-facing entry point. Standalone testable via slash-redeploy + Discord click.
2. Modal-Submit handler second — independent file, has `dispatch` API ready for index.js to chain.
3. Index.js dispatcher-chain third — connects the two, enables end-to-end flow. Manual E2E happens here.

Tasks 1+2 can technically be implemented in either order; this order matches the spec's narrative (§3 → §4 → §5).

---

## Task 1: `src/commands/announcement.js` — Slash + Modal-Show

**Files:**
- Create: `src/commands/announcement.js`

### Step 1: Create `src/commands/announcement.js`

```js
const {
  SlashCommandBuilder,
  MessageFlags,
  PermissionFlagsBits,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('announcement')
    .setDescription('Postet eine offizielle Announcement (Embed) im gewählten Channel.')
    .addChannelOption((o) =>
      o.setName('channel')
        .setDescription('Ziel-Channel (default: current)')
        .setRequired(false)
        .addChannelTypes(ChannelType.GuildText)
    )
    .addRoleOption((o) =>
      o.setName('ping')
        .setDescription('Optional: Rolle die geping\'t werden soll (inkl. @everyone)')
        .setRequired(false)
    ),

  requiredTier: 'moderator',

  async execute(interaction) {
    const targetChannel = interaction.options.getChannel('channel') ?? interaction.channel;

    // Channel-type guard
    if (!targetChannel?.isTextBased() || targetChannel.isDMBased()) {
      return interaction.reply({ content: '❌ Nur Text-Channels.', flags: MessageFlags.Ephemeral });
    }

    // Bot-permission guards in target channel
    const botPerms = targetChannel.permissionsFor(interaction.guild.members.me);
    if (!botPerms?.has(PermissionFlagsBits.SendMessages)) {
      return interaction.reply({
        content: `❌ Mir fehlt die Permission \`SendMessages\` in <#${targetChannel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!botPerms.has(PermissionFlagsBits.EmbedLinks)) {
      return interaction.reply({
        content: `❌ Mir fehlt die Permission \`EmbedLinks\` in <#${targetChannel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Ping role: optional. Wenn @everyone gewählt → extra MentionEveryone check.
    const pingRole = interaction.options.getRole('ping');
    const pingRoleId = pingRole?.id ?? 'none';

    if (pingRole && pingRole.id === interaction.guild.id) {
      if (!botPerms.has(PermissionFlagsBits.MentionEveryone)) {
        return interaction.reply({
          content: `❌ Mir fehlt die Permission \`MentionEveryone\` in <#${targetChannel.id}>.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    // Build modal
    const modal = new ModalBuilder()
      .setCustomId(`announcement:modal:${targetChannel.id}:${pingRoleId}`)
      .setTitle('Announcement erstellen');

    const titleInput = new TextInputBuilder()
      .setCustomId('title')
      .setLabel('Title')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(256);

    const descInput = new TextInputBuilder()
      .setCustomId('description')
      .setLabel('Description')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(4000);

    modal.addComponents(
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(descInput),
    );

    await interaction.showModal(modal);
  },
};
```

### Step 2: Smoke-load

```powershell
node --env-file=.env -e "const c = require('./src/commands/announcement'); console.log('announcement:', typeof c.execute, typeof c.data, c.requiredTier);"
```

Expected: `announcement: function object moderator`. No syntax errors.

### Step 3: Run all existing smoke tests (regression check)

```powershell
node tests/smoke/modlog.js
node --env-file=.env tests/smoke/duration.js
node --env-file=.env tests/smoke/reports.js
node --env-file=.env tests/smoke/escalations.js
```

Expected: all four exit 0.

### Step 4: Commit

```bash
git add src/commands/announcement.js
git commit -m "$(cat <<'EOF'
feat(announcement): /announcement slash + modal-show

Slash command (moderator-tier) opens a Discord-Modal with two
TextInputs (Title Short + Description Paragraph). customId encodes
target-channel + ping-role for the submit handler:
  announcement:modal:<channelId>:<roleId|none>

Pre-modal validation: channel-type-check, SendMessages+EmbedLinks
in target, MentionEveryone wenn @everyone gepickt. Failures sind
ephemeral, kein Modal opens.

Modal-Submit-Handler folgt in Task 2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `src/interactions/announcement.js` — Modal-Submit-Handler

**Files:**
- Create: `src/interactions/announcement.js`

The handler exports `dispatch(interaction)` — same pattern as `src/interactions/report.js` (returns boolean: `true` if handled, `false` if customId namespace doesn't match). This lets `index.js` chain dispatchers via `||`.

### Step 1: Create `src/interactions/announcement.js`

```js
const { EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const config = require('../config');

async function dispatch(interaction) {
  if (!interaction.customId) return false;
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'announcement') return false;
  if (parts[1] === 'modal' && interaction.isModalSubmit()) {
    await handleModalSubmit(interaction, parts);
    return true;
  }
  console.warn(`[announcement] unhandled customId kind=${parts[1]} interactionType=${interaction.type}`);
  return false;
}

async function handleModalSubmit(interaction, parts) {
  // Expect parts = ['announcement', 'modal', '<channelId>', '<roleId|none>']
  if (parts.length !== 4) {
    return interaction.reply({
      content: '❌ Ungültige Announcement-Interaktion.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const targetChannelId = parts[2];
  const pingRoleId = parts[3];

  // 1. Modal-Inputs lesen
  const title = interaction.fields.getTextInputValue('title').trim();
  const description = interaction.fields.getTextInputValue('description').trim();

  if (!title || !description) {
    return interaction.reply({
      content: '❌ Title und Description dürfen nicht leer sein.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // 2. Target-Channel re-fetchen (race-protection)
  const targetChannel = await interaction.guild.channels.fetch(targetChannelId).catch(() => null);
  if (!targetChannel?.isTextBased() || targetChannel.isDMBased()) {
    return interaction.reply({
      content: '❌ Target-Channel nicht mehr verfügbar.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // 3. Bot-Perms re-validieren
  const botPerms = targetChannel.permissionsFor(interaction.guild.members.me);
  if (!botPerms?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    return interaction.reply({
      content: `❌ Mir fehlen Permissions in <#${targetChannel.id}>.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // 4. Ping-Role resolveren
  let pingText = '';
  let allowedMentions = { parse: [] };

  if (pingRoleId !== 'none') {
    const pingRole = await interaction.guild.roles.fetch(pingRoleId).catch(() => null);
    if (pingRole) {
      if (pingRole.id === interaction.guild.id) {
        // @everyone role (everyone-role-id === guild-id)
        if (!botPerms.has(PermissionFlagsBits.MentionEveryone)) {
          return interaction.reply({
            content: `❌ Mir fehlt die Permission \`MentionEveryone\` in <#${targetChannel.id}>.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        pingText = '@everyone';
        allowedMentions = { parse: ['everyone'] };
      } else {
        pingText = `<@&${pingRole.id}>`;
        allowedMentions = { roles: [pingRole.id] };
      }
    }
    // Wenn pingRole === null (Rolle gelöscht zwischenzeitlich): silent skip
  }

  // 5. Embed bauen
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0x5865f2)
    .setFooter({ text: '🐾 Oreo' })
    .setTimestamp();

  // 6. Posten
  const payload = { embeds: [embed], allowedMentions };
  if (pingText) payload.content = pingText;

  let postedMessage;
  try {
    postedMessage = await targetChannel.send(payload);
  } catch (err) {
    console.warn('/announcement post failed:', err);
    return interaction.reply({
      content: `❌ Posting fehlgeschlagen: ${err.code ?? err.message ?? 'unbekannter Fehler'}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // 7. Success-Reply mit Message-Link
  const messageUrl = `https://discord.com/channels/${interaction.guildId}/${targetChannel.id}/${postedMessage.id}`;
  await interaction.reply({
    content: `✅ Announcement gepostet: ${messageUrl}`,
    flags: MessageFlags.Ephemeral,
  });

  // 8. Mod-Log-Embed (fail-soft, inline)
  try {
    const modLogChannelId = await config.getModLogChannelId(interaction.guildId);
    if (modLogChannelId) {
      const modLogChannel = await interaction.client.channels.fetch(modLogChannelId);
      if (modLogChannel) {
        const truncatedDesc = description.length > 500
          ? description.slice(0, 500) + '…'
          : description;

        const logEmbed = new EmbedBuilder()
          .setTitle('📢 Announcement')
          .setColor(0x5865f2)
          .addFields(
            { name: '🛡️ Moderator', value: `<@${interaction.user.id}>`, inline: true },
            { name: '📺 Channel', value: `<#${targetChannel.id}>`, inline: true },
            { name: '🔔 Ping', value: pingText || 'kein Ping', inline: true },
            { name: '📝 Title', value: title, inline: false },
            { name: '📄 Description', value: truncatedDesc, inline: false },
            { name: '🔗 Link', value: `[Zum Announcement](${messageUrl})`, inline: false },
          )
          .setFooter({ text: '🐾 Oreo' })
          .setTimestamp();

        await modLogChannel.send({ embeds: [logEmbed] });
      }
    }
  } catch (err) {
    console.warn('[announcement] modlog post failed:', err);
  }
}

module.exports = { dispatch };
```

### Step 2: Smoke-load

```powershell
node --env-file=.env -e "const m = require('./src/interactions/announcement'); console.log('announcement:', Object.keys(m).join(','), typeof m.dispatch);"
```

Expected: `announcement: dispatch function`.

### Step 3: Run all existing smoke tests

```powershell
node tests/smoke/modlog.js
node --env-file=.env tests/smoke/duration.js
node --env-file=.env tests/smoke/reports.js
node --env-file=.env tests/smoke/escalations.js
```

Expected: all four exit 0. This task adds a new file, no existing module is touched.

### Step 4: Commit

```bash
git add src/interactions/announcement.js
git commit -m "$(cat <<'EOF'
feat(announcement): modal-submit handler + dispatch API

src/interactions/announcement.js exports dispatch(interaction)
following the src/interactions/report.js pattern (return-boolean
for chain-able dispatch). handleModalSubmit reads Title +
Description from modal-fields, re-validates target-channel +
bot-perms (race-protection), resolves ping-role (incl. @everyone),
posts embed with allowedMentions, replies ephemeral mit
message-link, postet fail-soft Mod-Log mit truncated description.

Wire-up in index.js folgt in Task 3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `index.js` Dispatcher-Chain + Manual E2E + Push

**Files:**
- Modify: `index.js` (require + dispatch-chain in the component-dispatch block, ~line 83)

This task connects the two new modules and enables end-to-end flow.

### Step 1: Add the require statement near the top of `index.js`

In `index.js`, find the existing line (around line 7):
```js
const reportInteractions = require('./src/interactions/report');
```

Add a new require directly below it:
```js
const announcementInteractions = require('./src/interactions/announcement');
```

### Step 2: Extend the dispatch-chain

In the component-dispatch block (around line 83), find:

```js
  // Component path (button / string-select / modal-submit) — new
  if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
    try {
      const handled = await reportInteractions.dispatch(interaction);
      if (!handled) {
        await interaction.reply({ content: 'Unbekannte Interaktion.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      // Future feature dispatchers (escalation, automod) chain here:
      // const handled = await reportInteractions.dispatch(interaction) || await escalationInteractions.dispatch(interaction);
    } catch (e) {
```

Replace the `const handled = await reportInteractions.dispatch(interaction);` line with a chain that includes the announcement dispatcher:

```js
      const handled = await reportInteractions.dispatch(interaction)
                   || await announcementInteractions.dispatch(interaction);
```

The chain shape (`||` operator with short-circuit) ensures: report dispatcher checked first, if it returns `false`, announcement dispatcher gets a chance. Both return `true` only after handling. The line-comment about "future feature dispatchers" can be left as-is (or updated to remove "automod" mention — out of scope).

### Step 3: Smoke-load `index.js`

```powershell
node --env-file=.env -e "require('./index.js')" 2>&1 | head -10
```

Note: `index.js` is the bot entrypoint and will try to start a Discord client. The smoke test will likely log `MySQL reachable.` etc. and then start the bot — at which point it'll keep running. We just need to verify it loads without a require/syntax error.

A safer alternative is just the syntax check:
```powershell
node --env-file=.env --check ./index.js
```

Expected: no output, exit 0. `--check` parses-only, doesn't execute.

### Step 4: Restart bot to deploy + take effect

```powershell
docker compose --project-directory "c:/Users/Lukas/Documents/Oreo" up -d --build bot
docker compose --project-directory "c:/Users/Lukas/Documents/Oreo" logs bot --tail 20
```

Expected log lines:
- `MySQL reachable.`
- `Schema sichergestellt.`
- `Deployed N command(s) to guild ...` where N = previous count (23 after Stage 4) + 1 (the new `/announcement`) = **24**
- `Logged in as Oreo#...`

If `Deployed 24 command(s)` doesn't appear, check the log for `[commands] skipping ...` warnings — would indicate the new `announcement.js` doesn't expose `data` or `execute`.

### Step 5: Run all existing smoke tests (final regression check)

```powershell
node tests/smoke/modlog.js
node --env-file=.env tests/smoke/duration.js
node --env-file=.env tests/smoke/reports.js
node --env-file=.env tests/smoke/escalations.js
```

Expected: all four exit 0.

### Step 6: Manual E2E checklist (Spec §7.2)

**Setup:**
- Test-Guild mit Mod-Log konfiguriert (Stage 2b)
- Owner + Moderator + Member Accounts
- Bot mit `SendMessages`, `EmbedLinks`, `MentionEveryone` Permissions
- Test-Channel `#announcements`, Test-Rolle `@News`

**Permission-Gating (P1–P2):**
- [ ] **P1** Member ruft `/announcement` → ❌ Permission denied (moderator-required)
- [ ] **P2** Moderator + Owner können beide rufen → ✅ Modal öffnet

**Happy-Path (H1–H4):**
- [ ] **H1** `/announcement` (ohne params) → Modal öffnet → Title `Test` + Description `Hello **bold**` → Submit → Bot postet Embed im current channel mit gerenderter Bold-Formatting. Ephemeral Reply enthält Message-Link.
- [ ] **H2** `/announcement channel:#announcements` → Modal → fill → Submit → Embed landet in `#announcements` (nicht current)
- [ ] **H3** `/announcement ping:@News` → Modal → Submit → Bot postet `<@&News-ID>` als plain text VOR dem Embed. `@News`-Rolle wird tatsächlich geping't
- [ ] **H4** `/announcement ping:@everyone` → Modal → Submit → Bot postet `@everyone` plain text + Embed. @everyone-Ping geht raus

**Edge-Cases & Failures (F1–F6):**
- [ ] **F1** `/announcement channel:<Voice-Channel>` → ❌ "Nur Text-Channels" (Discord-side: voice-channels filtered durch addChannelTypes; sollte gar nicht angeboten werden. Falls doch: handled.)
- [ ] **F2** Bot `SendMessages` revoken in target channel → `/announcement` → ❌ "Mir fehlt die Permission SendMessages"
- [ ] **F3** Bot `EmbedLinks` revoken → ❌ "EmbedLinks"
- [ ] **F4** Bot `MentionEveryone` revoken, dann `ping:@everyone` → ❌ "MentionEveryone"
- [ ] **F5** Modal öffnen → Channel zwischenzeitlich löschen → Submit → ephemeral "Target-Channel nicht mehr verfügbar"
- [ ] **F6** `/announcement ping:@RoleX` öffnet Modal → RoleX zwischenzeitlich löschen → Submit → postet ohne Ping (silent skip)

**Modal-Inhalt (M1–M3):**
- [ ] **M1** Title max 256 chars → Discord-Client zeigt counter, blocks bei 257
- [ ] **M2** Description max 4000 chars → Discord-Client blocks bei 4001
- [ ] **M3** Submit mit nur Title (Description leer) → Discord-Client blocks (required-flag)

**Markdown-Rendering (MD1–MD4):**
- [ ] **MD1** Description `**Bold** _italic_ ~~strikethrough~~` → Embed rendert alle drei
- [ ] **MD2** Description mit ```code``` Block → gerendert
- [ ] **MD3** Description mit Discord-Mention `<@id>` → User-Mention klickbar (aber NICHT geping't, weil allowedMentions strict)
- [ ] **MD4** Description mit `||spoiler||` → Spoiler-Tag gerendert

**Mod-Log-Audit (L1–L3):**
- [ ] **L1** Nach jedem Happy-Path-Post: Mod-Log-Embed mit 📢 Announcement Titel, Mod-Mention, Channel-Mention, Ping-Info, truncated Description (≤500), Message-Link
- [ ] **L2** Mod-Log nicht konfiguriert (oder Bot ohne Perms in Mod-Log-Channel): Post in target-channel funktioniert weiter, kein Crash
- [ ] **L3** Mod-Log-Channel deleted: Post funktioniert weiter, console.warn

### Step 7: Confirm clean working tree

```powershell
git -C "c:/Users/Lukas/Documents/Oreo" status
```

Expected: nothing to commit, working tree clean.

### Step 8: Commit the index.js change

```bash
git add index.js
git commit -m "$(cat <<'EOF'
feat(index): chain announcementInteractions.dispatch in component handler

Add require + dispatch-chain so Modal-Submits mit
customId.startsWith('announcement:') vom announcement-Handler
verarbeitet werden. Pattern matches report-dispatcher's
return-boolean shape, chained via || short-circuit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Step 9: Push

```powershell
git -C "c:/Users/Lukas/Documents/Oreo" push origin main
```

Expected: 4 Stage-4b commits land on origin (Task 1 + Task 2 + Task 3-commit + plan-commit when written).

---

## Out-of-Scope Reminders (do NOT do these in this plan)

Per Spec §1 and §9:

- No `/announcement-edit` (Bot-Owned-Message-Edit) — out of scope
- No `/announcement-schedule` (defer to future time) — needs cron-job + persistent queue
- No Color-Choice slash-option — fix `0x5865f2` brand-blurple
- No Image/Thumbnail/Author-Field — keep modal at 2 TextInputs
- No auto-Reactions for poll-style — eigene `/poll`-Stage
- No Multi-Channel-Broadcast — one channel per /announcement
- No persistent Draft-State on modal-timeout
- No custom Mod-Log-Channel-Override (uses existing config.getModLogChannelId)
- No Schema-Change, kein DB-Access
- No new smoke tests (Modal-Flow is Discord-heavy)

---

## Self-Review Trace

**Spec coverage:**

| Spec section | Task | Covered? |
|---|---|---|
| §1 Ziel & Scope | Tasks 1, 2, 3 | ✓ |
| §2 Modul-Layout (2 NEU + 1 GEÄNDERT) | All tasks | ✓ |
| §3.1 Stufe 1 (Slash + showModal) | Task 1 | ✓ |
| §3.2 Stufe 2 (ModalSubmit-Routing + Handler) | Tasks 2, 3 | ✓ |
| §3.3 Stufe 3 (Mod-Log inline fail-soft) | Task 2 Step 1 (Mod-Log-block) | ✓ |
| §4.1 Slash-Builder | Task 1 Step 1 | ✓ |
| §4.2 Pre-Modal Permission-Checks | Task 1 Step 1 (channel-type + SendMessages + EmbedLinks + optional MentionEveryone) | ✓ |
| §4.3 Modal-Build | Task 1 Step 1 (lines mit `ModalBuilder`, `TextInputBuilder`) | ✓ |
| §4.4 customId-Schema | Task 1 Step 1 (`announcement:modal:${id}:${roleId}`); Task 2 Step 1 (parse) | ✓ |
| §5.1 Modul-API (dispatch + handleModalSubmit) | Task 2 Step 1 (module.exports = { dispatch }) | ✓ |
| §5.2 Handler-Flow (9 Steps) | Task 2 Step 1 (komplette handleModalSubmit-Funktion) | ✓ |
| §5.3 allowedMentions-Strategie | Task 2 Step 1 (4 Fälle: none/everyone/role/null) | ✓ |
| §6 Failure-Modes-Tabelle | Task 2 Step 1 (alle catch-Pfade) | ✓ |
| §7.1 Module-Load-Check | Tasks 1+2+3 Steps 2-3 | ✓ |
| §7.2 Manuelle E2E | Task 3 Step 6 (volle Checkliste) | ✓ |
| §8 Rollback | Implicit (additive only) | ✓ |
| §9 Open Questions | Out-of-scope-list above | n/a |
| §10 File-Plan-Summary | File Plan section above | ✓ |

**Placeholder scan:**
- No "TBD" / "TODO" / "implement later"
- No "add error handling" without specifics
- Every step has concrete code or exact PowerShell command
- "Similar to Task N" never used — each task has full code

**Type/identifier consistency:**
- `requiredTier: 'moderator'` — Task 1 (announcement.js)
- `customId` schema `announcement:modal:<channelId>:<roleId|none>` — Task 1 (emit) + Task 2 (parse) match
- `dispatch(interaction)` boolean-return — Task 2 (impl) + Task 3 (chained-call in index.js) match
- `PermissionFlagsBits.SendMessages` / `EmbedLinks` / `MentionEveryone` — Task 1 (pre-validate) + Task 2 (re-validate) match
- `pingRole.id === interaction.guild.id` (@everyone detection) — Task 1 + Task 2 use same logic
- `allowedMentions: { parse: [] }` / `{ parse: ['everyone'] }` / `{ roles: [id] }` — Task 2 (allocation matrix) consistent
- `messageUrl` format `https://discord.com/channels/${guildId}/${channelId}/${msgId}` — Task 2 Step 1 (in reply + mod-log embed) consistent
- Embed-Title `📢 Announcement` (Mod-Log) — Task 2 Step 1, consistent with Spec §3.3
- Color `0x5865f2` — Task 1 (Modal title decoration unused) + Task 2 (embed + mod-log embed) consistent
- Footer `🐾 Oreo` — Task 2 (embed + mod-log embed) consistent
- Description-truncate at 500 chars — Task 2 Step 1 (mod-log block), matches Spec §3.3
