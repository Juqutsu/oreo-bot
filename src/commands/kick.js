const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const cases = require('../cases');
const config = require('../config');
const { buildModLogEmbed } = require('../modlog');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kicke einen Spieler vom Server')
    .addUserOption((user) => user.setName("target").setDescription("Spieler zum kicken").setRequired(true))
    .addStringOption((r) => r.setName("reason").setDescription("Grund fürs kicken").setMaxLength(512).setRequired(false)),

  requiredTier: 'moderator',

  async execute(interaction) {
    
    const target = interaction.options.getUser('target');
    const reason = interaction.options.getString('reason') ?? 'Kein Grund angegeben';

    const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
    const moderator = interaction.member;
    const botMember = interaction.guild.members.me;

    if(target.id === moderator.id) return interaction.reply({ // Kann nicht selbst kicken
      content: 'Selbst-Kick geht nicht.',
      flags: MessageFlags.Ephemeral,
    });

    if(target.id === botMember.id) return interaction.reply({ // Kann bot nicht kicken
      content: 'Oreo kann sich nicht selber kicken.',
      flags: MessageFlags.Ephemeral,
    });

    if(target.id === interaction.guild.ownerId) return interaction.reply({ // Kann owner nicht kicken
      content: 'Den Server-Inhaber kannst du nicht kicken.',
      flags: MessageFlags.Ephemeral,
    });

    if(targetMember && moderator.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) return interaction.reply({ // Mod Hierarchie
      content: 'Diese Person hat dieselbe oder eine höhere Rolle als du.',
      flags: MessageFlags.Ephemeral,
    });

    if(targetMember && !targetMember.kickable) return interaction.reply({ // Bot Hierarchie + Permission
      content: 'Diese Person lässt sich nicht kicken. Vermutlich ist Oreos Rolle nicht hoch genug.',
      flags: MessageFlags.Ephemeral,
    });

    try {
      await interaction.guild.members.kick(target.id, {
        reason: `${moderator.user.tag}: ${reason}`,
      });
    } catch (e) {
      console.error(e);
      return interaction.reply({
        content: 'Der Kick hat nicht geklappt. Details stehen in den Logs.',
        flags: MessageFlags.Ephemeral,
      });
    }

    let caseNumber;
    try {
      const result = await cases.createCase({
        guildId: interaction.guildId,
        userId: target.id,
        moderatorId: moderator.id,
        type: 'kick',
        reason: interaction.options.getString('reason'),
      });
      caseNumber = result.caseNumber;
    } catch (err) {
      console.error('createCase failed:', err);
      caseNumber = null;
    }

    await interaction.reply({
      content: `**${target.username}** wurde gekickt. (Case #${caseNumber ?? 'nicht gespeichert'})`,
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
        action: 'kick',
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
