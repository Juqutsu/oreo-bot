const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const cases = require('../cases');
const config = require('../config');
const { buildModLogEmbed } = require('../modlog');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('Hebt die Stummschaltung (Mute-Rolle) eines Nutzers auf.')
    .addUserOption((o) => o.setName('target').setDescription('Wer soll entstummt werden?').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Grund für die Entstummung').setRequired(false)),

  requiredTier: 'moderator',

  async execute(interaction) {
    const target = interaction.options.getUser('target');
    const reason = interaction.options.getString('reason') ?? 'Kein Grund angegeben';
    const moderator = interaction.member;

    const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (!targetMember) {
      return interaction.reply({
        content: 'Dieser User ist nicht (mehr) auf dem Server.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const roleId = await config.getMutedRoleId(interaction.guildId);
    if (!roleId) {
      return interaction.reply({
        content: 'Es ist keine `Muted`-Rolle konfiguriert.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const hasRole = targetMember.roles.cache.has(roleId);
    if (!hasRole) {
      return interaction.reply({
        content: 'Dieser User hat die `Muted`-Rolle nicht.',
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      await targetMember.roles.remove(roleId, `${moderator.user.tag}: ${reason}`);
    } catch (e) {
      console.error(e);
      return interaction.reply({
        content: 'Das Entfernen der Mute-Rolle hat nicht geklappt.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Set active mutes to inactive
    try {
      await cases.deactivateActiveInfractions(interaction.guildId, target.id, 'mute');
    } catch (err) {
      console.warn('deactivateActiveInfractions failed:', err);
    }

    let caseNumber;
    try {
      const result = await cases.createCase({
        guildId: interaction.guildId,
        userId: target.id,
        moderatorId: moderator.id,
        type: 'unmute',
        reason: interaction.options.getString('reason'),
      });
      caseNumber = result.caseNumber;
    } catch (err) {
      console.error('createCase failed:', err);
      caseNumber = null;
    }

    await interaction.reply({
      content: `**${target.username}** wurde entstummt. (Case #${caseNumber ?? 'nicht gespeichert'})`,
      flags: MessageFlags.Ephemeral,
    });

    try {
      const channelId = await config.getModLogChannelId(interaction.guildId);
      if (channelId) {
        const logChannel = await interaction.client.channels.fetch(channelId);
        const modEmbed = buildModLogEmbed({
          action: 'unmute',
          caseNumber,
          target,
          mod: moderator,
          reason,
        });
        await logChannel.send({ embeds: [modEmbed] });
      }
    } catch (e) {
      console.warn('ModLog send failed:', e);
    }
  },
};
