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
