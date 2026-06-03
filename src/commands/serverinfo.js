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
