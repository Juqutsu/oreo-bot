const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const cases = require('../cases');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('removewarn')
    .setDescription('Entfernt eine Verwarnung (Soft-Delete + Audit-Case).')
    .addIntegerOption((option) => option.setName('case_number').setDescription('Case-Nummer der Verwarnung').setRequired(true).setMinValue(1))
    .addStringOption((option) => option.setName('reason').setDescription('Grund für die Entfernung').setRequired(false))
,

  requiredTier: 'mod',

  async execute(interaction) {
    const originalCaseNumber = interaction.options.getInteger('case_number');
    const reasonInput = interaction.options.getString('reason');
    const reasonForDisplay = reasonInput ?? 'Kein Grund angegeben';
    const moderator = interaction.member;

    // 1. Original-Case prüfen (für klare Fehlermeldungen).
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
    if (original.type !== 'warn') {
      return interaction.reply({
        content: `Case #${originalCaseNumber} ist kein Warn (Type: ${original.type}).`,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!original.active) {
      return interaction.reply({
        content: `Case #${originalCaseNumber} ist bereits entfernt.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // 2. Soft-Delete + Meta-Case.
    let metaCaseNumber;
    try {
      const result = await cases.removeWarn({
        guildId: interaction.guildId,
        originalCaseNumber,
        moderatorId: moderator.id,
        reason: reasonInput,
      });
      if (!result) {
        return interaction.reply({
          content: `Case #${originalCaseNumber} konnte nicht entfernt werden (Race-Condition?).`,
          flags: MessageFlags.Ephemeral,
        });
      }
      metaCaseNumber = result.metaCaseNumber;
    } catch (err) {
      console.error('removeWarn failed:', err);
      return interaction.reply({
        content: 'Datenbankfehler — versuch es später nochmal.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 3. DM an Target (Best-Effort).
    let dmFailed = false;
    try {
      const target = await interaction.client.users.fetch(original.user_id);
      const dmEmbed = new EmbedBuilder()
        .setTitle(`✅ Verwarnung aufgehoben auf ${interaction.guild.name}`)
        .setColor(0x57f287)
        .addFields(
          { name: '🆔 Original-Case', value: `#${originalCaseNumber}`, inline: true },
          { name: '🛡️ Aufgehoben von', value: `<@${moderator.id}>`, inline: true },
          { name: '📝 Grund', value: reasonForDisplay, inline: false },
        )
        .setFooter({ text: '🐾 Oreo' })
        .setTimestamp();
      await target.send({ embeds: [dmEmbed] });
    } catch (err) {
      dmFailed = true;
    }

    // 4. Mod-Reply.
    await interaction.reply({
      content: `Verwarnung Case #${originalCaseNumber} entfernt (Audit Case #${metaCaseNumber}).`,
      flags: MessageFlags.Ephemeral,
    });

    // 5. Mod-Log-Embed (Best-Effort).
    try {
      const logChannel = await interaction.client.channels.fetch(process.env.MODLOG_CHANNEL_ID);
      const modEmbed = new EmbedBuilder()
        .setTitle('✅ Verwarnung entfernt')
        .setColor(0x57f287)
        .addFields(
          { name: '👤 User', value: `<@${original.user_id}>`, inline: false },
          { name: '🛡️ Moderator', value: `<@${moderator.id}>`, inline: false },
          { name: '🔗 Original-Case', value: `#${originalCaseNumber}`, inline: true },
          { name: '📝 Grund', value: reasonForDisplay, inline: false },
        );
      if (dmFailed) {
        modEmbed.addFields({ name: '📬 DM', value: 'Nicht zugestellt (DMs aus?)', inline: false });
      }
      modEmbed.setFooter({ text: `Case #${metaCaseNumber} · 🐾` }).setTimestamp();
      await logChannel.send({ embeds: [modEmbed] });
    } catch (err) {
      console.warn('ModLog send failed:', err);
      await interaction.followUp({
        content: 'Mod-Log-Eintrag fehlgeschlagen. Bitte `MODLOG_CHANNEL_ID` prüfen.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
