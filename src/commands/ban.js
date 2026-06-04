const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const cases = require('../cases');
const config = require('../config');
const { buildModLogEmbed } = require('../modlog');
const { parseDuration } = require('../duration');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Bannt einen Nutzer vom Server.')
    .addUserOption((option) => option.setName('target').setDescription('Wer soll gebannt werden?').setRequired(true))
    .addStringOption((option) => option.setName('duration').setDescription('Optional: Dauer des Bans (z.B. 30m, 2h, 7d)').setRequired(false))
    .addStringOption((reason) => reason.setName('reason').setDescription('Grund für den Ban').setRequired(false)),

  requiredTier: 'owner',

  async execute(interaction) {
    const target = interaction.options.getUser('target');
    const durationInput = interaction.options.getString('duration');
    const reason = interaction.options.getString('reason') ?? 'Kein Grund angegeben';

    let durationMs = null;
    let expiresAt = null;

    if (durationInput) {
      durationMs = parseDuration(durationInput);
      if (!durationMs) {
        return interaction.reply({
          content: '❌ Ungültige Dauer. Nutze z.B. `30s`, `10m`, `2h`, `7d`.',
          flags: MessageFlags.Ephemeral,
        });
      }
      expiresAt = new Date(Date.now() + durationMs);
    }

    const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
    const moderator = interaction.member;
    const botMember = interaction.guild.members.me;

    if(target.id === moderator.id) return interaction.reply({ // Kann nicht selbst bannen
      content: 'Selbst-Ban geht nicht.',
      flags: MessageFlags.Ephemeral,
    });

    if(target.id === botMember.id) return interaction.reply({ // Kann bot nicht bannen
      content: 'Oreo kann sich nicht selber bannen.',
      flags: MessageFlags.Ephemeral,
    });

    if(target.id === interaction.guild.ownerId) return interaction.reply({ // Kann owner nicht bannen
      content: 'Den Server-Inhaber kannst du nicht bannen.',
      flags: MessageFlags.Ephemeral,
    });

    if(targetMember && moderator.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) return interaction.reply({ // Mod Hierarchie
      content: 'Diese Person hat dieselbe oder eine höhere Rolle als du.',
      flags: MessageFlags.Ephemeral,
    });

    if(targetMember && !targetMember.bannable) return interaction.reply({ // Bot Hierarchie + Permission
      content: 'Diese Person lässt sich nicht bannen. Vermutlich ist Oreos Rolle nicht hoch genug.',
      flags: MessageFlags.Ephemeral,
    });

    try {
      await interaction.guild.members.ban(target.id, {
        reason: `${moderator.user.tag}: ${reason}`,
      });
    } catch (e) {
      console.error(e);
      return interaction.reply({
        content: 'Der Ban hat nicht geklappt. Details stehen in den Logs.',
        flags: MessageFlags.Ephemeral,
      });
    }

    let caseNumber;
    try {
      const result = await cases.createCase({
        guildId: interaction.guildId,
        userId: target.id,
        moderatorId: moderator.id,
        type: 'ban',
        reason: interaction.options.getString('reason'),
        durationMs: durationMs ? BigInt(durationMs) : null,
        expiresAt,
      });
      caseNumber = result.caseNumber;
    } catch (err) {
      console.error('createCase failed:', err);
      caseNumber = null;
    }

    const banMessage = durationMs 
      ? `**${target.username}** wurde temporär gebannt. (Case #${caseNumber ?? 'nicht gespeichert'})`
      : `**${target.username}** wurde permanent gebannt. (Case #${caseNumber ?? 'nicht gespeichert'})`;

    await interaction.reply({
      content: banMessage,
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
        action: 'ban',
        caseNumber,
        target,
        mod: moderator,
        reason,
        durationMs,
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