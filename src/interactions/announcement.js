const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');
const config = require('../config');
const perms = require('../perms');
const announcements = require('../announcements');
const { COLORS, buildAnnouncementModal } = require('../commands/announcement');

// ---------- Preview session store ----------
//
// A "preview session" bridges the modal submit (create/edit/resume) and the
// follow-up button clicks (post/reedit/cancel) on the ephemeral preview message.
// Keyed by nonce = the interaction.id of the FIRST modal submit that created the
// session; `resume` (re-edit) submits reuse that same nonce so the buttons on a
// re-rendered preview keep pointing at the same session entry.
//
// Shape: nonce -> { mode: 'create'|'edit', announcementId: null|Number,
//   targetChannelId, pingRoleId, colorKey, title, description, imageUrl,
//   userId, expiresAt }
const previewSessions = new Map();
const PREVIEW_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Evicts expired preview sessions so abandoned create/edit flows don't leak memory.
function sweepSessions() {
  const now = Date.now();
  for (const [nonce, session] of previewSessions) {
    if (session.expiresAt < now) previewSessions.delete(nonce);
  }
}

const sweepInterval = setInterval(sweepSessions, 60_000);
sweepInterval.unref?.();

// ---------- Helpers ----------

// Reverse-maps a stored embed color (INT) back to its COLORS key, for prefilling
// an edit-session's colorKey from a DB row. Falls back to 'blurple' if the value
// doesn't match any known color (e.g. legacy row, custom color, or null).
function colorKeyFromValue(colorValue) {
  const entry = Object.entries(COLORS).find(([, value]) => value === colorValue);
  return entry ? entry[0] : 'blurple';
}

// Display-only ping formatting for the ephemeral preview line (NOT used for the
// actual post — handlePostCreate re-resolves + re-validates the role itself).
function formatPingText(pingRoleId, guildId) {
  if (!pingRoleId || pingRoleId === 'none') return null;
  return pingRoleId === guildId ? '@everyone' : `<@&${pingRoleId}>`;
}

/**
 * Builds the announcement embed shared by the preview and the final post.
 * @param {{ title: string, description: string, color: number, imageUrl?: string|null,
 *   createdAt?: Date|null, edited?: boolean }} params
 */
function buildAnnouncementEmbed({ title, description, color, imageUrl = null, createdAt = null, edited = false }) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: edited ? '🐾 Oreo • bearbeitet' : '🐾 Oreo' })
    .setTimestamp(createdAt ?? new Date());

  if (imageUrl) embed.setImage(imageUrl);

  return embed;
}

function buildPreviewButtons(nonce, mode) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`announcement:preview:post:${nonce}`)
      .setLabel(mode === 'edit' ? '✅ Übernehmen' : '✅ Posten')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`announcement:preview:reedit:${nonce}`)
      .setLabel('✏️ Bearbeiten')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`announcement:preview:cancel:${nonce}`)
      .setLabel('❌ Abbrechen')
      .setStyle(ButtonStyle.Danger),
  );
}

// Renders (replies with) the ephemeral preview for a (freshly built or resumed)
// session. Modal submits are NOT auto-deferred by index.js (only ChatInput commands
// are), so a direct interaction.reply() here is correct — matches how captcha.js
// replies directly to modal-less button interactions.
async function renderPreview(interaction, nonce, session, { imageWarning = null } = {}) {
  let createdAt = null;
  const edited = session.mode === 'edit';

  if (edited && session.announcementId) {
    try {
      const row = await announcements.getAnnouncement(interaction.guildId, session.announcementId);
      if (row) createdAt = row.created_at;
    } catch (err) {
      // Fail-soft: preview still renders, just without the original timestamp.
      console.error('[announcement] failed to load original createdAt for edit preview:', err);
    }
  }

  const embed = buildAnnouncementEmbed({
    title: session.title,
    description: session.description,
    color: COLORS[session.colorKey] ?? COLORS.blurple,
    imageUrl: session.imageUrl,
    createdAt,
    edited,
  });

  const pingText = formatPingText(session.pingRoleId, interaction.guildId);
  let content = `Vorschau — Ziel: <#${session.targetChannelId}>`;
  if (pingText) content += ` · Ping: ${pingText}`;
  if (imageWarning) content += `\n${imageWarning}`;

  await interaction.reply({
    content,
    embeds: [embed],
    components: [buildPreviewButtons(nonce, session.mode)],
    flags: MessageFlags.Ephemeral,
  });
}

// ---------- Modal-submit handler (create / edit / resume) ----------

async function handleModalSubmit(interaction, parts) {
  if (!(await perms.requireTier(interaction, 'moderator'))) return;

  const kind = parts[2]; // create | edit | resume

  const title = interaction.fields.getTextInputValue('title').trim();
  const description = interaction.fields.getTextInputValue('description').trim();
  const imageUrlRaw = interaction.fields.getTextInputValue('image_url').trim();

  if (!title || !description) {
    await interaction.reply({
      content: '❌ Title und Description dürfen nicht leer sein.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Bild-URL-Validierung: leer -> kein Bild; ungültig -> Vorschau ohne Bild + Warnung.
  let imageUrl = null;
  let imageWarning = null;
  if (imageUrlRaw) {
    if (/^https:\/\/\S+$/i.test(imageUrlRaw)) {
      imageUrl = imageUrlRaw;
    } else {
      imageWarning = '⚠️ Die Bild-URL ist ungültig (muss mit https:// beginnen) — sie wird ignoriert. Öffne ✏️ Bearbeiten, um sie zu korrigieren.';
    }
  }

  let nonce;
  let session;

  if (kind === 'create') {
    // announcement:modal:create:<channelId>:<pingRoleId|none>:<colorKey>
    if (parts.length !== 6) {
      await interaction.reply({ content: '❌ Ungültige Announcement-Interaktion.', flags: MessageFlags.Ephemeral });
      return;
    }
    const [, , , targetChannelId, pingRoleId, rawColorKey] = parts;

    nonce = interaction.id;
    session = {
      mode: 'create',
      announcementId: null,
      targetChannelId,
      pingRoleId,
      colorKey: COLORS[rawColorKey] !== undefined ? rawColorKey : 'blurple',
      title,
      description,
      imageUrl,
      userId: interaction.user.id,
      expiresAt: Date.now() + PREVIEW_TTL_MS,
    };
    previewSessions.set(nonce, session);
  } else if (kind === 'edit') {
    // announcement:modal:edit:<announcementId>
    if (parts.length !== 4) {
      await interaction.reply({ content: '❌ Ungültige Announcement-Interaktion.', flags: MessageFlags.Ephemeral });
      return;
    }
    const announcementId = Number.parseInt(parts[3], 10);
    if (Number.isNaN(announcementId)) {
      await interaction.reply({ content: '❌ Ungültige Announcement-Interaktion.', flags: MessageFlags.Ephemeral });
      return;
    }

    let row;
    try {
      row = await announcements.getAnnouncement(interaction.guildId, announcementId);
    } catch (err) {
      console.error('[announcement] failed to load announcement for edit:', err);
      await interaction.reply({ content: '❌ Datenbankfehler beim Laden des Announcements.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!row || row.status === 'deleted') {
      await interaction.reply({ content: `❌ Announcement #${announcementId} nicht gefunden.`, flags: MessageFlags.Ephemeral });
      return;
    }

    nonce = interaction.id;
    session = {
      mode: 'edit',
      announcementId,
      targetChannelId: row.channel_id,
      pingRoleId: row.ping_role_id ?? 'none',
      colorKey: colorKeyFromValue(row.color),
      title,
      description,
      imageUrl,
      userId: interaction.user.id,
      expiresAt: Date.now() + PREVIEW_TTL_MS,
    };
    previewSessions.set(nonce, session);
  } else if (kind === 'resume') {
    // announcement:modal:resume:<nonce>
    nonce = parts[3];
    const existing = previewSessions.get(nonce);

    if (!existing || existing.expiresAt < Date.now()) {
      previewSessions.delete(nonce);
      await interaction.reply({
        content: '⏳ Diese Vorschau ist abgelaufen — starte neu mit /announcement.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (existing.userId !== interaction.user.id) {
      await interaction.reply({ content: '❌ Diese Vorschau gehört zu jemand anderem.', flags: MessageFlags.Ephemeral });
      return;
    }

    existing.title = title;
    existing.description = description;
    existing.imageUrl = imageUrl;
    existing.expiresAt = Date.now() + PREVIEW_TTL_MS; // keep session alive while user is actively editing
    session = existing;
  } else {
    console.warn(`[announcement] unhandled modal kind=${kind}`);
    await interaction.reply({ content: '❌ Ungültige Announcement-Interaktion.', flags: MessageFlags.Ephemeral });
    return;
  }

  await renderPreview(interaction, nonce, session, { imageWarning });
}

// ---------- Preview button handler (post / reedit / cancel) ----------

async function handlePreviewButton(interaction, parts) {
  if (!(await perms.requireTier(interaction, 'moderator'))) return;

  const action = parts[2]; // post | reedit | cancel
  const nonce = parts[3];
  const session = previewSessions.get(nonce);

  if (!session || session.expiresAt < Date.now()) {
    previewSessions.delete(nonce);
    await interaction.update({
      content: '⏳ Diese Vorschau ist abgelaufen — starte neu mit /announcement.',
      embeds: [],
      components: [],
    });
    return;
  }

  if (session.userId !== interaction.user.id) {
    await interaction.reply({ content: '❌ Diese Vorschau gehört zu jemand anderem.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'cancel') {
    previewSessions.delete(nonce);
    await interaction.update({ content: '✅ Abgebrochen — nichts wurde gepostet.', embeds: [], components: [] });
    return;
  }

  if (action === 'reedit') {
    // Button interactions can show modals just like ChatInput commands.
    await interaction.showModal(
      buildAnnouncementModal({
        customId: `announcement:modal:resume:${nonce}`,
        title: session.title,
        description: session.description,
        imageUrl: session.imageUrl ?? '',
      }),
    );
    return;
  }

  if (action === 'post') {
    if (session.mode === 'edit') {
      // Applying an edit to the already-posted message/DB row lands in Task 4.
      await interaction.reply({ content: '⏳ Edit-Anwendung folgt in Task 4.', flags: MessageFlags.Ephemeral });
      return;
    }
    await handlePostCreate(interaction, nonce, session);
    return;
  }

  console.warn(`[announcement] unhandled preview action=${action}`);
}

// ---------- Post handler (mode: create) ----------
//
// Reuses the permission re-validation, allowedMentions construction, message-URL
// building, and "📢 Announcement" modlog embed from the pre-preview-flow version
// of this module — only the response method (interaction.update() on the existing
// ephemeral preview instead of a fresh interaction.reply()) changes, since this is
// now reached from a button click instead of directly from the modal submit.
async function handlePostCreate(interaction, nonce, session) {
  // 1. Target-Channel re-fetchen (race-protection)
  const targetChannel = await interaction.guild.channels.fetch(session.targetChannelId).catch(() => null);
  if (!targetChannel?.isTextBased() || targetChannel.isDMBased()) {
    await interaction.reply({ content: '❌ Target-Channel nicht mehr verfügbar.', flags: MessageFlags.Ephemeral });
    return;
  }

  // 2. Bot-Perms re-validieren
  const botPerms = targetChannel.permissionsFor(interaction.guild.members.me);
  if (!botPerms?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    await interaction.reply({ content: `❌ Mir fehlen Permissions in <#${targetChannel.id}>.`, flags: MessageFlags.Ephemeral });
    return;
  }

  // 3. Ping-Role resolven
  let pingText = '';
  let allowedMentions = { parse: [] };

  if (session.pingRoleId !== 'none') {
    const pingRole = await interaction.guild.roles.fetch(session.pingRoleId).catch(() => null);
    if (pingRole) {
      if (pingRole.id === interaction.guild.id) {
        // @everyone role (everyone-role-id === guild-id)
        if (!botPerms.has(PermissionFlagsBits.MentionEveryone)) {
          await interaction.reply({
            content: `❌ Mir fehlt die Permission \`MentionEveryone\` in <#${targetChannel.id}>.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        pingText = '@everyone';
        allowedMentions = { parse: ['everyone'] };
      } else {
        pingText = `<@&${pingRole.id}>`;
        allowedMentions = { roles: [pingRole.id] };
      }
    }
    // Wenn pingRole === null (Rolle gelöscht zwischenzeitlich): silent skip, kein Ping
  }

  // 4. Embed bauen + posten
  const color = COLORS[session.colorKey] ?? COLORS.blurple;
  const embed = buildAnnouncementEmbed({
    title: session.title,
    description: session.description,
    color,
    imageUrl: session.imageUrl,
  });

  const payload = { embeds: [embed], allowedMentions };
  if (pingText) payload.content = pingText;

  let postedMessage;
  try {
    postedMessage = await targetChannel.send(payload);
  } catch (err) {
    console.warn('/announcement post failed:', err);
    await interaction.reply({
      content: `❌ Posting fehlgeschlagen: ${err.code ?? err.message ?? 'unbekannter Fehler'}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const messageUrl = `https://discord.com/channels/${interaction.guildId}/${targetChannel.id}/${postedMessage.id}`;

  // 5. In der Verwaltung speichern (fail-soft — Posting ist bereits passiert)
  let dbWarning = '';
  try {
    await announcements.createAnnouncement({
      guildId: interaction.guildId,
      channelId: targetChannel.id,
      messageId: postedMessage.id,
      authorId: interaction.user.id,
      title: session.title,
      description: session.description,
      color,
      imageUrl: session.imageUrl,
      pingRoleId: session.pingRoleId !== 'none' ? session.pingRoleId : null,
    });
  } catch (err) {
    console.error('[announcement] failed to persist announcement:', err);
    dbWarning = '\n⚠️ Gepostet, aber NICHT in der Verwaltung gespeichert (Datenbankfehler) — Bearbeiten/Löschen über den Bot ist für dieses Announcement nicht möglich.';
  }

  previewSessions.delete(nonce);

  await interaction.update({
    content: `✅ Announcement gepostet: ${messageUrl}${dbWarning}`,
    embeds: [],
    components: [],
  });

  // 6. Mod-Log-Embed (fail-soft)
  try {
    const modLogChannelId = await config.getModLogChannelId(interaction.guildId);
    if (modLogChannelId) {
      const modLogChannel = await interaction.client.channels.fetch(modLogChannelId);
      if (modLogChannel) {
        const truncatedDesc = session.description.length > 500
          ? session.description.slice(0, 500) + '…'
          : session.description;

        const logEmbed = new EmbedBuilder()
          .setTitle('📢 Announcement')
          .setColor(0x5865f2)
          .addFields(
            { name: '🛡️ Moderator', value: `<@${interaction.user.id}>`, inline: true },
            { name: '📺 Channel', value: `<#${targetChannel.id}>`, inline: true },
            { name: '🔔 Ping', value: pingText || 'kein Ping', inline: true },
            { name: '📝 Title', value: session.title, inline: false },
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

// ---------- Dispatcher ----------

async function dispatch(interaction) {
  if (!interaction.customId) return false;
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'announcement') return false;

  if (parts[1] === 'modal' && interaction.isModalSubmit()) {
    await handleModalSubmit(interaction, parts);
    return true;
  }

  if (parts[1] === 'preview' && interaction.isButton()) {
    await handlePreviewButton(interaction, parts);
    return true;
  }

  console.warn(`[announcement] unhandled customId kind=${parts[1]} interactionType=${interaction.type}`);
  return false;
}

module.exports = {
  dispatch,
  _internal: { previewSessions, buildAnnouncementEmbed, PREVIEW_TTL_MS, sweepSessions },
};
