const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const cases = require('../cases');
const config = require('../config');
const { sendModLog } = require('../modlog');
const { validateModTarget } = require('../modGuards');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('Hebt die Stummschaltung (Mute-Rolle) eines Nutzers auf.')
    .addUserOption((o) => o.setName('target').setDescription('Wer soll entstummt werden?').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Grund für die Entstummung').setMaxLength(512).setRequired(false)),

  requiredTier: 'moderator',

  async execute(interaction) {
    const target = interaction.options.getUser('target');
    const reason = interaction.options.getString('reason') ?? 'Kein Grund angegeben';
    const moderator = interaction.member;

    // Standard guards (member required, self/owner/hierarchy — /unmute has no bot-self guard).
    const guard = await validateModTarget(interaction, target, { action: 'unmute' });
    if (!guard.ok) {
      return interaction.reply({ content: guard.message, flags: MessageFlags.Ephemeral });
    }
    const targetMember = guard.targetMember;

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

    // Unlike before, this now also warns the moderator when the mod-log channel
    // is unset or the send fails (previously /unmute skipped these warnings).
    await sendModLog(interaction, {
      action: 'unmute',
      caseNumber,
      target,
      mod: moderator,
      reason,
    });
  },
};
