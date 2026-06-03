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
