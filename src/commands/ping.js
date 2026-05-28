const { SlashCommandBuilder, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Prüft, ob Oreo wach ist.'),

  async execute(interaction) {
    await interaction.reply({
      content: 'Pong!',
      flags: MessageFlags.Ephemeral,
    });
  },
};
