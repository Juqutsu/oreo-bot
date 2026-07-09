const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const config = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Steuerung des Voice-Recognition-Systems')
    .addSubcommand((sub) =>
      sub.setName('join')
        .setDescription('Lässt den Bot deinem aktuellen Voice-Kanal beitreten.')
    )
    .addSubcommand((sub) =>
      sub.setName('leave')
        .setDescription('Lässt den Bot den Voice-Kanal verlassen.')
    ),

  requiredTier: 'supporter',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'join') {
      const recEnabled = await config.getVoiceRecEnabled(interaction.guildId);
      if (!recEnabled) {
        return interaction.reply({
          content: '❌ Voice-Recognition ist für diesen Server deaktiviert. Ein Admin kann sie über `/config voice` aktivieren. Solange sie aus ist, trete ich keinem Voice-Kanal bei (Datenschutz: Audio würde zur Spracherkennung an einen externen Dienst gestreamt).',
          flags: MessageFlags.Ephemeral,
        });
      }

      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel) {
        return interaction.reply({
          content: '❌ Du musst dich in einem Voice-Kanal befinden, damit ich beitreten kann.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // Check if bot has permissions to join and speak (or listen)
      const permissions = voiceChannel.permissionsFor(interaction.client.user);
      if (!permissions.has('Connect')) {
        return interaction.reply({
          content: '❌ Mir fehlt die Berechtigung, deinem Voice-Kanal beizutreten (Connect).',
          flags: MessageFlags.Ephemeral,
        });
      }

      try {
        joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: voiceChannel.guild.id,
          adapterCreator: voiceChannel.guild.voiceAdapterCreator,
          selfDeaf: false, // WICHTIG: Muss false sein, um Audio zu empfangen!
          selfMute: true,  // Bot muss selbst nicht sprechen
        });

        return interaction.reply({
          content: `✅ Voice-Kanal **${voiceChannel.name}** beigetreten. Ich höre jetzt zu!`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        console.error('Error joining voice channel:', err);
        return interaction.reply({
          content: '❌ Fehler beim Beitritt zum Voice-Kanal.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    if (sub === 'leave') {
      const connection = getVoiceConnection(interaction.guildId);
      if (!connection) {
        return interaction.reply({
          content: '❌ Ich befinde mich derzeit in keinem Voice-Kanal.',
          flags: MessageFlags.Ephemeral,
        });
      }

      try {
        connection.destroy();
        return interaction.reply({
          content: '✅ Voice-Kanal verlassen.',
          flags: MessageFlags.Ephemeral,
        });
      } catch (err) {
        console.error('Error leaving voice channel:', err);
        return interaction.reply({
          content: '❌ Fehler beim Verlassen des Voice-Kanals.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  },
};
