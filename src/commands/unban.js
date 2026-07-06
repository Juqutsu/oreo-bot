const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const cases = require('../cases');
const config = require('../config');
const { buildModLogEmbed } = require('../modlog');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Hebt den Ban eines Users auf.')
    .addStringOption((option) =>
      option
        .setName('target')
        .setDescription('Welcher User soll entbannt werden?')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((reason) =>
      reason.setName('reason').setDescription('Grund für die Entbannung').setMaxLength(512).setRequired(false),
    ),

  requiredTier: 'owner',

  async autocomplete(interaction) {
    const query = interaction.options.getFocused().toLowerCase();
    const bans = await interaction.guild.bans.fetch();

    const choices = bans
      .filter(({ user }) => user.username.toLowerCase().includes(query))
      .map(({ user }) => ({
        name: `${user.username} (${user.id})`,
        value: user.id,
      }));

    await interaction.respond(choices.slice(0, 25));
  },

  async execute(interaction) {
    const targetId = interaction.options.getString('target');
    const reason = interaction.options.getString('reason') ?? 'Kein Grund angegeben';
    const moderator = interaction.member;

    const ban = await interaction.guild.bans.fetch(targetId).catch(() => null);
    if (!ban) {
      return interaction.reply({
        content: 'Dieser User ist nicht gebannt.',
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      await interaction.guild.bans.remove(targetId, `${moderator.user.tag}: ${reason}`);
    } catch (e) {
      console.error(e);
      return interaction.reply({
        content: 'Die Entbannung hat nicht geklappt. Details stehen in den Logs.',
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      await cases.deactivateActiveInfractions(interaction.guildId, targetId, 'ban');
    } catch (err) {
      console.warn('deactivateActiveInfractions failed:', err);
    }

    let caseNumber;
    try {
      const result = await cases.createCase({
        guildId: interaction.guildId,
        userId: targetId,
        moderatorId: moderator.id,
        type: 'unban',
        reason: interaction.options.getString('reason'),
      });
      caseNumber = result.caseNumber;
    } catch (err) {
      console.error('createCase failed:', err);
      caseNumber = null;
    }

    await interaction.reply({
      content: `**${ban.user.username}** wurde entbannt. (Case #${caseNumber ?? 'nicht gespeichert'})`,
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
        action: 'unban',
        caseNumber,
        target: ban.user,
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
