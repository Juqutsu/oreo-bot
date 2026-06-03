# Stage 4b — `/announcement` Command Design

**Date:** 2026-06-03
**Status:** Approved (brainstorming session)
**Author:** Lukas (mit Claude Opus 4.7)

**Stage-Marker:** Stage 4b — Follow-up zu Stage 4 (utility commands). Stage 5 bleibt für Automod reserviert.

---

## 1. Ziel & Scope

**Was die Stage baut:** `/announcement` — moderator+ Tier-Command für offizielle Server-Announcements. Mod öffnet via Slash ein Discord-Modal mit zwei Feldern (Title + Description), submit → Bot postet im gewählten Channel als Embed (blurple), optional mit Role-Ping davor (inkl. @everyone). Mod-Log captured Wer/Wo/Was inkl. Message-Link.

**Slash-Command-Signatur:**
```
/announcement [channel:#X] [ping:@Role]
```
- `channel` optional, default = current channel, nur TextChannel-Type
- `ping` optional, Discord-Role-Picker (inkl. @everyone). Bei Auswahl: Bot prepended Mention als plain text VOR dem Embed.

**Modal-Fields (2):**
1. **Title** (TextInputStyle.Short, required, max 256 Zeichen)
2. **Description** (TextInputStyle.Paragraph, required, max 4000 Zeichen)

**Embed-Layout:**
- Color: `0x5865f2` (brand-blurple, fix)
- Title aus Modal-Input
- Description aus Modal-Input (Discord-Markdown wird gerendert: Bold, Italic, Strikethrough, Code-Blocks, Quote, Lists, Spoilers, Links, User-/Role-/Channel-Mentions)
- Footer: `🐾 Oreo`
- `.setTimestamp()`

**Tier-Gate:** `moderator` — matches Stage 4 destruktive Commands (cleanup/slowmode/lockdown/unlock).

**Out-of-Scope** (bewusst weggelassen):
- Footer-Customization
- Embed-Image / Thumbnail / Author-Field
- Color-Choice (fix blurple)
- Schedule/Defer (post-at-future-time)
- Edit existing announcement
- Multi-Channel-Broadcast (one channel per /announcement)
- Cross-Server-Sync
- Auto-Reactions (`✅`/`❌` für Poll-style — eigene `/poll`-Stage wenn gewünscht)
- Custom Mod-Log-Channel-Override (uses existing `config.getModLogChannelId`)
- Persistent Draft-State (wenn Modal-Submit zu spät → Discord-Timeout, kein State-Recovery)

## 2. Modul-Layout

```
NEU
├── src/commands/announcement.js          (~70 LoC — Slash-Builder + Modal-Show)
└── src/interactions/announcement.js      (~110 LoC — Modal-Submit-Handler + post + mod-log)

GEÄNDERT
└── index.js (+5 LoC — Dispatcher-Arm für customId.startsWith('announcement:'))
```

**Modul-Verantwortlichkeiten:**

| File | Verantwortung |
|---|---|
| `src/commands/announcement.js` | Slash-Builder, Pre-Modal-Validation (channel-type, bot-perms), Modal-Build, `interaction.showModal(modal)` |
| `src/interactions/announcement.js` | Modal-Submit-Handler: customId-Parse, Re-Validation (race-protection), Embed-Post, Reply, Mod-Log |
| `index.js` | Dispatcher-Arm: ModalSubmitInteraction mit `customId.startsWith('announcement:')` → routet zu `src/interactions/announcement.handleModalSubmit` |

**Auto-Discovery:** `src/loadCommands.js` pickt `announcement.js` automatisch (file-glob loader, kein Registration-Step nötig).

## 3. Interaktions-Flow

Drei Stufen über zwei separate Discord-Interactions:

### 3.1 Stufe 1 — Slash-Command-Invocation

```
Mod: /announcement channel:#news ping:@everyone
  ↓
src/commands/announcement.js: execute()
  ↓
  1. Resolve targetChannel = options.getChannel('channel') ?? interaction.channel
  2. Channel-type-check (TextChannel only)
  3. Bot-perms check: SendMessages + EmbedLinks im Target-Channel
  4. Wenn ping=@everyone: zusätzlich MentionEveryone-Check
  5. Resolve pingRole = options.getRole('ping'); pingRoleId = pingRole?.id ?? 'none'
  6. Build modal mit customId = `announcement:modal:${targetChannel.id}:${pingRoleId}`
  7. await interaction.showModal(modal)
  ↓
Discord rendert das Modal-Popup beim Mod
(KEINE expliziite Bot-Reply — showModal IS die Antwort)
```

### 3.2 Stufe 2 — Modal-Submit (separate Discord-Interaction)

```
Mod tippt Title + Description, klickt Submit
  ↓
ModalSubmitInteraction kommt rein
  ↓
index.js Dispatcher: customId.startsWith('announcement:') → src/interactions/announcement.handleModalSubmit
  ↓
src/interactions/announcement.js: handleModalSubmit(interaction)
  ↓
  1. Parse customId → targetChannelId + pingRoleId
  2. Read Modal-Inputs: title + description
  3. Empty-check (defensive — Discord enforced required-flag already)
  4. Re-fetch targetChannel (race-protection: kann zwischenzeitlich gelöscht sein)
  5. Re-validate Bot-perms in target-channel
  6. Wenn pingRoleId !== 'none': re-fetch role
       - Wenn Role = @everyone (role.id === guild.id): pingText='@everyone', allowedMentions.parse=['everyone'], re-check MentionEveryone perm
       - Wenn andere Role: pingText=`<@&id>`, allowedMentions.roles=[role.id]
       - Wenn Role gelöscht: silent skip (kein Ping, postet ohne)
  7. Build embed (Title + Description + Color + Footer + Timestamp)
  8. await targetChannel.send({ content: pingText, embeds: [embed], allowedMentions })
  9. Build messageUrl = `https://discord.com/channels/${guildId}/${channelId}/${msgId}`
  10. interaction.reply ephemeral `'✅ Announcement gepostet: ${messageUrl}'`
```

### 3.3 Stufe 3 — Mod-Log (inline, fail-soft)

Direkt nach erfolgreichem Post (Stufe 2 Schritt 10) — innerhalb desselben Handlers:

```
try {
  const modLogChannelId = await config.getModLogChannelId(interaction.guildId);
  if (!modLogChannelId) return;
  const modLogChannel = await client.channels.fetch(modLogChannelId);
  if (!modLogChannel) return;

  const truncatedDesc = description.length > 500 ? description.slice(0, 500) + '…' : description;

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
} catch (err) {
  console.warn('[announcement] modlog post failed:', err);
}
```

Description wird auf 500 Zeichen + `…` truncated (volle Description steht im Public-Channel sowieso, Mod-Log braucht keine Full-Copy).

## 4. `src/commands/announcement.js` — Slash + Modal-Show

### 4.1 Slash-Builder

```js
const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, ChannelType,
        ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('announcement')
    .setDescription('Postet eine offizielle Announcement (Embed) im gewählten Channel.')
    .addChannelOption((o) => o.setName('channel').setDescription('Ziel-Channel (default: current)').setRequired(false).addChannelTypes(ChannelType.GuildText))
    .addRoleOption((o) => o.setName('ping').setDescription('Optional: Rolle die geping\'t werden soll (inkl. @everyone)').setRequired(false)),

  requiredTier: 'moderator',

  async execute(interaction) {
    // ... (see §4.2)
  },
};
```

### 4.2 Permission-Check-Matrix (vor showModal)

| Check | Failure-Reply (ephemeral) |
|---|---|
| Target-Channel kein Text-Channel | `❌ Nur Text-Channels.` |
| Bot fehlt `SendMessages` in Target | `` `❌ Mir fehlt die Permission \`SendMessages\` in <#${targetChannel.id}>.` `` |
| Bot fehlt `EmbedLinks` in Target | `` `❌ Mir fehlt die Permission \`EmbedLinks\` in <#${targetChannel.id}>.` `` |
| ping=@everyone + Bot fehlt `MentionEveryone` | `` `❌ Mir fehlt die Permission \`MentionEveryone\` in <#${targetChannel.id}>.` `` |

Alle Failures sind ephemeral, **kein Modal opens**. Wenn alle Checks passen → `interaction.showModal(modal)`.

### 4.3 Modal-Build

```js
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
```

### 4.4 customId-Schema

`announcement:modal:<channelId>:<roleId|none>` — 4 colon-separated parts.
- `parts[0] = 'announcement'` (namespace)
- `parts[1] = 'modal'` (kind)
- `parts[2] = channelId` (target channel Snowflake)
- `parts[3] = roleId | 'none'` (ping role Snowflake or sentinel)

Length-Check: 2× 19-digit Snowflakes + Prefix ≈ 55 chars, safe unter Discord-Limit (100 chars per customId).

## 5. `src/interactions/announcement.js` — Modal-Submit-Handler

### 5.1 Modul-API

```js
async function handleModalSubmit(interaction) {
  // Entry point from index.js dispatcher
  // Receives a ModalSubmitInteraction with customId starting with 'announcement:'
  // ... (see §5.2)
}

module.exports = { handleModalSubmit };
```

Eine exportierte Funktion, alles andere intern.

### 5.2 Handler-Flow (vollständig)

```js
async function handleModalSubmit(interaction) {
  // 1. customId parsen
  const parts = interaction.customId.split(':');
  if (parts.length !== 4 || parts[1] !== 'modal') {
    return interaction.reply({ content: '❌ Ungültige Announcement-Interaktion.', flags: MessageFlags.Ephemeral });
  }
  const targetChannelId = parts[2];
  const pingRoleId = parts[3];

  // 2. Modal-Inputs lesen
  const title = interaction.fields.getTextInputValue('title').trim();
  const description = interaction.fields.getTextInputValue('description').trim();

  if (!title || !description) {
    return interaction.reply({
      content: '❌ Title und Description dürfen nicht leer sein.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // 3. Target-Channel re-fetchen (race-protection)
  const targetChannel = await interaction.guild.channels.fetch(targetChannelId).catch(() => null);
  if (!targetChannel?.isTextBased() || targetChannel.isDMBased()) {
    return interaction.reply({
      content: '❌ Target-Channel nicht mehr verfügbar.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // 4. Bot-Perms re-validieren
  const botPerms = targetChannel.permissionsFor(interaction.guild.members.me);
  if (!botPerms?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    return interaction.reply({
      content: `❌ Mir fehlen Permissions in <#${targetChannel.id}>.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // 5. Ping-Role resolveren
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
    // Wenn pingRole === null (Rolle gelöscht): silent skip, kein Ping
  }

  // 6. Embed bauen
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0x5865f2)
    .setFooter({ text: '🐾 Oreo' })
    .setTimestamp();

  // 7. Posten
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

  // 8. Success-Reply mit Message-Link
  const messageUrl = `https://discord.com/channels/${interaction.guildId}/${targetChannel.id}/${postedMessage.id}`;
  await interaction.reply({
    content: `✅ Announcement gepostet: ${messageUrl}`,
    flags: MessageFlags.Ephemeral,
  });

  // 9. Mod-Log (fail-soft, inline) — siehe §3.3
  // ... (Mod-Log embed-build + post + console.warn on failure)
}
```

### 5.3 allowedMentions-Strategie

| pingRoleId | pingText | allowedMentions |
|---|---|---|
| `'none'` | `''` (kein content) | `{ parse: [] }` (keine Auto-Mentions) |
| @everyone (role.id === guild.id) | `'@everyone'` | `{ parse: ['everyone'] }` |
| Andere Role | `` `<@&${id}>` `` | `{ roles: [id] }` |
| Role gelöscht (fetch returns null) | `''` (kein content) | `{ parse: [] }` |

**Konsequenz:** Title und Description aus dem Modal können raw Discord-mentions (`@everyone`, `<@id>`, `<@&id>`) enthalten — die werden aber **nicht** geping't weil `allowedMentions` strict ist (nur die explizit gewählte Ping-Quelle wird auto-ping't).

## 6. Failure-Modes-Tabelle

| Fall | Verhalten |
|---|---|
| Member-Tier < moderator | Existing tier-gate enforced via `requiredTier: 'moderator'` (kein Code in announcement.js nötig) |
| Modal-Submit zu spät (>15min nach showModal) | Discord-side timeout, Submit kommt nie an, kein Eingriff nötig |
| Target-Channel zwischen Slash + Submit gelöscht | ephemeral '❌ Target-Channel nicht mehr verfügbar.' |
| Bot-Perms entzogen zwischen Slash + Submit | ephemeral '❌ Mir fehlen Permissions in <#${channel.id}>.' |
| Ping-Role zwischen Slash + Submit gelöscht | silent skip, postet ohne Ping (no Failure-Reply) |
| `channel.send` wirft (Discord 5xx / Rate-Limit-Spillover / unknown) | ephemeral '❌ Posting fehlgeschlagen: ${err.code ?? err.message}' |
| Mod-Log-Channel nicht konfiguriert | post war erfolgreich; mod-log silent skip; `console.warn` |
| Mod-Log-Channel gelöscht / Bot ohne Perms in Mod-Log | post war erfolgreich; mod-log fail-soft; `console.warn` |
| customId malformed (parts.length !== 4) | ephemeral '❌ Ungültige Announcement-Interaktion.' (sollte nie passieren, defensive) |
| Modal returns empty Title oder Description trotz required-flag | ephemeral '❌ Title und Description dürfen nicht leer sein.' (defensive) |

## 7. Testing

### 7.1 Smoke-Tests

**Keine neuen automated Smoke-Tests.** Begründung:
- Modal-Flow ist primär Discord-Interaktion + Embed-Build
- Kein DAL, keine DB-Query
- Mocking-Aufwand übersteigt Test-Mehrwert

**Module-Load-Check (catches Syntax-Errors):**
```powershell
node --env-file=.env -e "['./src/commands/announcement','./src/interactions/announcement'].forEach(p => { const m = require(p); console.log(p, Object.keys(m).join(',')); })"
```

Erwartet:
- `./src/commands/announcement data,execute,requiredTier`
- `./src/interactions/announcement handleModalSubmit`

### 7.2 Manuelle E2E

**Setup:**
- Test-Guild mit Mod-Log konfiguriert
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
- [ ] **F1** `/announcement channel:<Voice-Channel>` → ❌ "Nur Text-Channels"
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
- [ ] **L2** Mod-Log nicht konfiguriert: Post funktioniert weiter, kein Crash, console.warn
- [ ] **L3** Mod-Log-Channel deleted: Post funktioniert weiter, console.warn

## 8. Rollback

- **3 Files:**
  - Delete `src/commands/announcement.js` → `/announcement` verschwindet aus Discord nach Slash-Redeploy
  - Delete `src/interactions/announcement.js` → modal-submit-Handler weg
  - Revert `index.js` Dispatcher-Arm → unbenannte `announcement:`-customIds würden fail-soft ignoriert (oder eine generic "Unknown interaction"-Reply triggern, je nach Dispatcher-Default)
- **Kein Schema, kein DB-State** — keine Migration zu reverten
- **Existing Announcement-Embeds bleiben** im Discord-Channel-History (sind gepostete Messages, nicht Bot-State)
- **Mod-Log-Einträge bleiben** in Mod-Log-Channel-History

Volle Reversibilität auf Bot-Seite ohne Daten-Verlust.

## 9. Open Questions / Future Work

- **`/announcement-edit`** — Editing einer bereits geposteten Announcement (via Message-ID oder Link). Würde Bot-Owned-Message-Edit erfordern.
- **`/announcement-schedule`** — Defer-to-future-Time. Würde Cron-Job + persistent queue brauchen.
- **Color-Choice** — Slash-Option `color:<info|success|warning|danger>` mit ENUM-Mapping. Nützlich für unterschiedliche Announcement-Types.
- **Image/Thumbnail** — Modal-Field für URL oder Slash-Option für Attachment. Embed-Image-Field.
- **Embed-Author / Footer-Customization** — zusätzliche Modal-Fields.
- **Auto-Reactions** — Slash-Option für initial Reactions (z.B. `✅`/`❌` für Poll-style).
- **`/poll`** als separates Command — strukturierter, Vote-Tracking, Embed-Updates.
- **Multi-Channel-Broadcast** — Slash-Option `additional_channels:<comma-separated>` zum gleichzeitigen Posten.
- **Persistent Drafts** — wenn Mod-Modal-Submit timeout, draft als DM zurück.

## 10. File-Plan-Summary

```
NEU
├── src/commands/announcement.js                    (~70 LoC)
└── src/interactions/announcement.js                (~110 LoC)

GEÄNDERT
└── index.js                                        (+5 LoC Dispatcher-Arm)

ENTFERNT
└── (nichts)
```

Netto-Delta: ca. **+185 LoC**, 2 neue Files + 1 modifizierter Dispatcher. Kleinste Stage seit Stage 2c-Trivial-Adds.
