const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const cases = require('../cases');
const config = require('../config');
const { buildModLogEmbed } = require('../modlog');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Verwarnt einen Nutzer und speichert es als Case.')
    .addUserOption((option) => option.setName('target').setDescription('Wer soll verwarnt werden?').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('Grund für die Verwarnung').setRequired(false)),

  requiredTier: 'moderator',

  async execute(interaction) {
    const target = interaction.options.getUser('target');
    const reasonInput = interaction.options.getString('reason');
    const reasonForDisplay = reasonInput ?? 'Kein Grund angegeben';

    const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
    const moderator = interaction.member;
    const botMember = interaction.guild.members.me;

    if (!targetMember) return interaction.reply({
      content: 'Dieser User ist nicht (mehr) auf dem Server.',
      flags: MessageFlags.Ephemeral,
    });

    if (target.id === moderator.id) return interaction.reply({
      content: 'Selbst-Verwarnung geht nicht.',
      flags: MessageFlags.Ephemeral,
    });

    if (target.id === botMember.id) return interaction.reply({
      content: 'Oreo kann sich nicht selber verwarnen.',
      flags: MessageFlags.Ephemeral,
    });

    if (target.id === interaction.guild.ownerId) return interaction.reply({
      content: 'Den Server-Inhaber kannst du nicht verwarnen.',
      flags: MessageFlags.Ephemeral,
    });

    if (moderator.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) return interaction.reply({
      content: 'Diese Person hat dieselbe oder eine höhere Rolle als du.',
      flags: MessageFlags.Ephemeral,
    });

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
        action: 'warn',
        caseNumber,
        target,
        mod: moderator,
        reason: reasonForDisplay,
        dmFailed,
      });
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
