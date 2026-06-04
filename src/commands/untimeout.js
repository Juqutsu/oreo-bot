const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const cases = require('../cases');
const config = require('../config');
const { buildModLogEmbed } = require('../modlog');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription('Hebt den Timeout eines Users auf.')
    .addUserOption((option) => option.setName('target').setDescription('Welcher User soll aus dem Timeout?').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('Grund für die Aufhebung').setRequired(false)),

  requiredTier: 'moderator',

  async execute(interaction) {
    const target = interaction.options.getUser('target');
    const reason = interaction.options.getString('reason') ?? 'Kein Grund angegeben';

    const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
    const moderator = interaction.member;

    if (!targetMember) return interaction.reply({
      content: 'Dieser User ist nicht (mehr) auf dem Server.',
      flags: MessageFlags.Ephemeral,
    });

    if (!targetMember.isCommunicationDisabled()) return interaction.reply({
      content: 'Dieser User ist gar nicht im Timeout.',
      flags: MessageFlags.Ephemeral,
    });

    if (moderator.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) return interaction.reply({
      content: 'Diese Person hat dieselbe oder eine höhere Rolle als du.',
      flags: MessageFlags.Ephemeral,
    });

    if (!targetMember.moderatable) return interaction.reply({
      content: 'Diese Person lässt sich nicht aus dem Timeout holen. Vermutlich ist Oreos Rolle nicht hoch genug.',
      flags: MessageFlags.Ephemeral,
    });

    try {
      await targetMember.timeout(null, `${moderator.user.tag}: ${reason}`);
    } catch (e) {
      console.error(e);
      return interaction.reply({
        content: 'Das Aufheben hat nicht geklappt. Details stehen in den Logs.',
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      await cases.deactivateActiveInfractions(interaction.guildId, target.id, 'timeout');
    } catch (err) {
      console.warn('deactivateActiveInfractions failed:', err);
    }

    let caseNumber;
    try {
      const result = await cases.createCase({
        guildId: interaction.guildId,
        userId: target.id,
        moderatorId: moderator.id,
        type: 'untimeout',
        reason: interaction.options.getString('reason'),
      });
      caseNumber = result.caseNumber;
    } catch (err) {
      console.error('createCase failed:', err);
      caseNumber = null;
    }

    await interaction.reply({
      content: `**${target.username}** ist wieder aus dem Timeout.`,
      flags: MessageFlags.Ephemeral,
    });

    try {
      const channelId = await config.getModLogChannelId(interaction.guildId);
      if (!channelId) {
        await interaction.followUp({
          content: 'Mod-Log nicht konfiguriert. Admin: `/config channel set type:modlog channel:<#x>` ausführen.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const logChannel = await interaction.client.channels.fetch(channelId);
      const modEmbed = buildModLogEmbed({
        action: 'untimeout',
        caseNumber,
        target,
        mod: moderator,
        reason,
      });
      await logChannel.send({ embeds: [modEmbed] });
    } catch (e) {
      console.warn('ModLog send failed:', e);
      await interaction.followUp({
        content: 'Mod-Log-Eintrag fehlgeschlagen — Channel-Permission oder Channel-ID prüfen.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
