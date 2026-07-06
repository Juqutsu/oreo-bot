const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const cases = require('../cases');
const config = require('../config');
const { buildModLogEmbed } = require('../modlog');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('softban')
    .setDescription('Bannt einen Nutzer und entbannt ihn sofort wieder, um Nachrichten zu löschen.')
    .addUserOption((option) => option.setName('target').setDescription('Wer soll soft-gebannt werden?').setRequired(true))
    .addStringOption((reason) => reason.setName('reason').setDescription('Grund für den Softban').setMaxLength(512).setRequired(false)),

  requiredTier: 'owner',

  async execute(interaction) {
    const target = interaction.options.getUser('target');
    const reason = interaction.options.getString('reason') ?? 'Kein Grund angegeben';

    const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
    const moderator = interaction.member;
    const botMember = interaction.guild.members.me;

    if (target.id === moderator.id) {
      return interaction.reply({
        content: 'Selbst-Softban geht nicht.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (target.id === botMember.id) {
      return interaction.reply({
        content: 'Oreo kann sich nicht selber soft-bannen.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (target.id === interaction.guild.ownerId) {
      return interaction.reply({
        content: 'Den Server-Inhaber kannst du nicht soft-bannen.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (targetMember && moderator.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) {
      return interaction.reply({
        content: 'Diese Person hat dieselbe oder eine höhere Rolle als du.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (targetMember && !targetMember.bannable) {
      return interaction.reply({
        content: 'Diese Person lässt sich nicht bannen/soft-bannen. Vermutlich ist Oreos Rolle nicht hoch genug.',
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      // 1. Ban user to purge messages (delete last 7 days of messages)
      await interaction.guild.members.ban(target.id, {
        reason: `Softban von ${moderator.user.tag}: ${reason}`,
        deleteMessageSeconds: 7 * 24 * 60 * 60,
      });

      // 2. Immediately unban
      await interaction.guild.members.unban(target.id, `Softban-Aufhebung für ${target.tag}`);
    } catch (e) {
      console.error(e);
      return interaction.reply({
        content: 'Der Softban hat nicht geklappt. Details stehen in den Logs.',
        flags: MessageFlags.Ephemeral,
      });
    }

    let caseNumber;
    try {
      const result = await cases.createCase({
        guildId: interaction.guildId,
        userId: target.id,
        moderatorId: moderator.id,
        type: 'softban',
        reason: interaction.options.getString('reason'),
        active: 0, // Softban is completed immediately, so it is not active
      });
      caseNumber = result.caseNumber;
    } catch (err) {
      console.error('createCase failed:', err);
      caseNumber = null;
    }

    await interaction.reply({
      content: `**${target.username}** wurde soft-gebannt. (Case #${caseNumber ?? 'nicht gespeichert'})`,
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
        action: 'softban',
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
