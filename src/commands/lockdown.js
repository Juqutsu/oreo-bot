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
