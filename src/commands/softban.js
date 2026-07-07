const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const cases = require('../cases');
const { sendModLog } = require('../modlog');
const { validateModTarget } = require('../modGuards');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('softban')
    .setDescription('Bannt einen Nutzer und entbannt ihn sofort wieder, um Nachrichten zu löschen.')
    .addUserOption((option) => option.setName('target').setDescription('Wer soll soft-gebannt werden?').setRequired(true))
    .addStringOption((reason) => reason.setName('reason').setDescription('Grund für den Softban').setMaxLength(512).setRequired(false)),

  requiredTier: 'moderator',

  async execute(interaction) {
    const target = interaction.options.getUser('target');
    const reason = interaction.options.getString('reason') ?? 'Kein Grund angegeben';

    const moderator = interaction.member;

    // Standard guards (self/bot/owner/hierarchy/bannable) — softban works on non-members too.
    const guard = await validateModTarget(interaction, target, { action: 'softban', requireMember: false });
    if (!guard.ok) {
      return interaction.reply({ content: guard.message, flags: MessageFlags.Ephemeral });
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

    await sendModLog(interaction, {
      action: 'softban',
      caseNumber,
      target,
      mod: moderator,
      reason,
    });
  },
};
