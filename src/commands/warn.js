const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const cases = require('../cases');
const { sendModLog } = require('../modlog');
const { validateModTarget } = require('../modGuards');
const escalations = require('../escalations');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Verwarnt einen Nutzer und speichert es als Case.')
    .addUserOption((option) => option.setName('target').setDescription('Wer soll verwarnt werden?').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('Grund für die Verwarnung').setMaxLength(512).setRequired(false)),

  requiredTier: 'supporter',

  async execute(interaction) {
    const target = interaction.options.getUser('target');
    const reasonInput = interaction.options.getString('reason');
    const reasonForDisplay = reasonInput ?? 'Kein Grund angegeben';

    const moderator = interaction.member;

    // Standard guards (member required, self/bot/owner/hierarchy).
    const guard = await validateModTarget(interaction, target, { action: 'warn' });
    if (!guard.ok) {
      return interaction.reply({ content: guard.message, flags: MessageFlags.Ephemeral });
    }

    // 1. Case in DB schreiben (wenn das failt, brechen wir komplett ab).
    let caseNumber;
    try {
      const result = await cases.createCase({
        guildId: interaction.guildId,
        userId: target.id,
        moderatorId: moderator.id,
        type: 'warn',
        reason: reasonInput,
      });
      caseNumber = result.caseNumber;
    } catch (err) {
      console.error('createCase failed:', err);
      return interaction.reply({
        content: 'Datenbankfehler — versuch es später nochmal.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 2. DM an Target (Best-Effort).
    let dmFailed = false;
    try {
      const dmEmbed = new EmbedBuilder()
        .setTitle(`⚠️ Verwarnung auf ${interaction.guild.name}`)
        .setColor(0xfaa61a)
        .addFields(
          { name: '📝 Grund', value: reasonForDisplay, inline: false },
          { name: '🆔 Case', value: `#${caseNumber}`, inline: true },
        )
        .setFooter({ text: '🐾 Oreo' })
        .setTimestamp();
      await target.send({ embeds: [dmEmbed] });
    } catch (err) {
      dmFailed = true;
    }

    // 3. Mod-Reply.
    await interaction.reply({
      content: `**${target.username}** wurde verwarnt (Case #${caseNumber}).`,
      flags: MessageFlags.Ephemeral,
    });

    // 4. Mod-Log-Embed (Best-Effort).
    await sendModLog(interaction, {
      action: 'warn',
      caseNumber,
      target,
      mod: moderator,
      reason: reasonForDisplay,
      dmFailed,
    });

    // Auto-Eskalation
    try {
      const activeWarnCount = await cases.countActiveWarnings(interaction.guildId, target.id);
      await escalations.applyEscalation({ interaction, target, activeWarnCount });
    } catch (err) {
      console.warn('Escalation failed:', err);
    }
  },
};
