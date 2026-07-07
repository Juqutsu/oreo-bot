const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const cases = require('../cases');
const { sendModLog } = require('../modlog');
const { validateModTarget } = require('../modGuards');

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

    const moderator = interaction.member;

    // Standard guards (self/bot/owner/hierarchy/kickable). requireMember stays false:
    // the previous inline guards also ran without a member (the kick itself fails then).
    const guard = await validateModTarget(interaction, target, { action: 'kick', requireMember: false });
    if (!guard.ok) {
      return interaction.reply({ content: guard.message, flags: MessageFlags.Ephemeral });
    }
    const targetMember = guard.targetMember;

    // DM an Target (Best-Effort) — muss VOR dem Kick passieren, danach ist der User evtl. nicht mehr erreichbar.
    if (targetMember) {
      const dmEmbed = new EmbedBuilder()
        .setTitle(`👢 Kick auf ${interaction.guild.name}`)
        .setColor(0xe67e22)
        .addFields(
          { name: '📝 Grund', value: reason, inline: false },
        )
        .setFooter({ text: '🐾 Oreo' })
        .setTimestamp();
      await target.send({ embeds: [dmEmbed] }).catch(() => null);
    }

    try {
      await interaction.guild.members.kick(target.id, `${moderator.user.tag}: ${reason}`);
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

    await sendModLog(interaction, {
      action: 'kick',
      caseNumber,
      target,
      mod: moderator,
      reason,
    });
  },
};
