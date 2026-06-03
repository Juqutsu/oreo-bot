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
