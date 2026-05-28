const { SlashCommandBuilder, MessageFlags, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kicke einen Spieler vom Server')
    .addUserOption((user) => user.setName("target").setDescription("Spieler zum kicken").setRequired(true))
    .addStringOption((r) => r.setName("reason").setDescription("Grund fürs kicken").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers), 

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

    if(targetMember && !targetMember.bannable) return interaction.reply({ // Bot Hierarchie + Permission
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

    await interaction.reply({
      content: `**${target.username}** wurde gekickt.`,
      flags: MessageFlags.Ephemeral,
    });

    try {
          const logChannel = await interaction.client.channels.fetch(process.env.MODLOG_CHANNEL_ID);
          const modEmbed = new EmbedBuilder()
            .setTitle('User gekickt')
            .setColor(0xed4245)
            .setThumbnail(target.displayAvatarURL({ size: 256 }))
            .addFields(
              { name: '👤 User', value: `<@${target.id}>`, inline: false },
              { name: '🛡️ Moderator', value: `<@${moderator.id}>`, inline: false },
              { name: '📝 Grund', value: reason, inline: false },
            )
            .setFooter({ text: 'Case ID: TODO · 🐾' })
            .setTimestamp();
          await logChannel.send({ embeds: [modEmbed] });
        } catch (e) {
          console.warn('ModLog send failed:', e);
          await interaction.followUp({
            content: 'Mod-Log-Eintrag fehlgeschlagen. Bitte `MODLOG_CHANNEL_ID` prüfen.',
            flags: MessageFlags.Ephemeral,
          });
        }

  },
};
