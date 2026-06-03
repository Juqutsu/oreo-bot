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
    // Wenn pingRole === null (Rolle gelöscht zwischenzeitlich): silent skip, kein Ping
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
