const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const cases = require('../cases');
const config = require('../config');

const META_TYPES = new Set(['warn_removed', 'reason_edited']);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('reason')
    .setDescription('Editiert den Grund eines bestehenden Cases.')
    .addIntegerOption((option) => option.setName('case_number').setDescription('Case-Nummer').setRequired(true).setMinValue(1))
    .addStringOption((option) => option.setName('new_reason').setDescription('Neuer Grund').setRequired(true)),

  requiredTier: 'moderator',

  async execute(interaction) {
    const originalCaseNumber = interaction.options.getInteger('case_number');
    const newReason = interaction.options.getString('new_reason');
    const moderator = interaction.member;

    // 1. Original-Case prüfen.
    // Hinweis: zwischen diesem Read und dem späteren editReason() existiert eine
    // TOCTOU-Lücke. Beabsichtigt — schlimmster Fall ist ein redundanter
    // reason_edited Meta-Case (wenn ein anderer Mod parallel editiert), keine
    // Datenkorruption. editReason() sperrt den Case selbst via FOR UPDATE.
    let original;
    try {
      original = await cases.getCaseByNumber(interaction.guildId, originalCaseNumber);
    } catch (err) {
      console.error('getCaseByNumber failed:', err);
      return interaction.reply({
        content: 'Datenbankfehler — versuch es später nochmal.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!original) {
      return interaction.reply({
        content: `Case #${originalCaseNumber} nicht gefunden.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (META_TYPES.has(original.type)) {
      return interaction.reply({
        content: 'Audit-Cases (warn_removed/reason_edited) können nicht editiert werden.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (original.reason === newReason) {
      return interaction.reply({
        content: 'Neuer Grund ist identisch zum bestehenden — Abbruch.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 2. Reason editieren.
    let metaCaseNumber;
    let oldReason;
    try {
      const result = await cases.editReason({
        guildId: interaction.guildId,
        originalCaseNumber,
        moderatorId: moderator.id,
        newReason,
      });
      if (!result) {
        return interaction.reply({
          content: `Case #${originalCaseNumber} konnte nicht editiert werden.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      metaCaseNumber = result.metaCaseNumber;
      oldReason = result.oldReason;
    } catch (err) {
      console.error('editReason failed:', err);
      return interaction.reply({
        content: 'Datenbankfehler — versuch es später nochmal.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 3. Mod-Reply (kein DM — Mod-interne Korrektur).
    await interaction.reply({
      content: `Grund für Case #${originalCaseNumber} aktualisiert (Audit Case #${metaCaseNumber}).`,
      flags: MessageFlags.Ephemeral,
    });

    // 4. Mod-Log-Embed.
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
      const modEmbed = new EmbedBuilder()
        .setTitle('📝 Grund editiert')
        .setColor(0x5865f2)
        .addFields(
          { name: '👤 User', value: `<@${original.user_id}>`, inline: false },
          { name: '🛡️ Moderator', value: `<@${moderator.id}>`, inline: false },
          { name: '🔗 Original-Case', value: `#${originalCaseNumber}`, inline: true },
          { name: '📝 Alt', value: oldReason ?? '(leer)', inline: false },
          { name: '📝 Neu', value: newReason, inline: false },
        )
        .setFooter({ text: `Case #${metaCaseNumber} · 🐾` })
        .setTimestamp();
      await logChannel.send({ embeds: [modEmbed] });
    } catch (err) {
      console.warn('ModLog send failed:', err);
      await interaction.followUp({
        content: 'Mod-Log-Eintrag fehlgeschlagen — Channel-Permission oder Channel-ID prüfen.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
