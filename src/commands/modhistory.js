const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const cases = require('../cases');

const TYPE_ICONS = {
  warn: '⚠️',
  timeout: '🔇',
  untimeout: '🔊',
  kick: '👢',
  ban: '🔨',
  unban: '🔓',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('modhistory')
    .setDescription('Zeigt die komplette Mod-Historie eines Users.')
    .addUserOption((option) => option.setName('user').setDescription('Wessen Historie?').setRequired(true))
    .addBooleanOption((option) => option.setName('include_inactive').setDescription('Auch entfernte/aufgehobene Aktionen zeigen (Default: ja)').setRequired(false)),

  requiredTier: 'supporter',

  async execute(interaction) {
    const target = interaction.options.getUser('user');
    const includeInactive = interaction.options.getBoolean('include_inactive') ?? true;

    let infractions;
    try {
      infractions = await cases.listUserInfractions(interaction.guildId, target.id, { includeInactive, limit: 25 });
    } catch (err) {
      console.error('listUserInfractions failed:', err);
      return interaction.reply({
        content: 'Datenbankfehler — versuch es später nochmal.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (infractions.length === 0) {
      return interaction.reply({
        content: `**${target.username}** hat keine Mod-Historie.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(`🛡️ Mod-Historie von ${target.username}`)
      .setColor(0x5865f2)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .setFooter({ text: `Insgesamt angezeigt: ${infractions.length} · 🐾` })
      .setTimestamp();

    for (const inf of infractions) {
      const icon = TYPE_ICONS[inf.type] ?? '•';
      const date = new Date(inf.created_at);
      const dateStr = `<t:${Math.floor(date.getTime() / 1000)}:f>`;
      const reason = inf.reason ?? 'Kein Grund angegeben';
      const inactiveBadge = inf.active ? '' : ' [ENTFERNT]';
      embed.addFields({
        name: `${icon} Case #${inf.case_number}${inactiveBadge}`,
        value: `${dateStr}\nvon <@${inf.moderator_id}>\n${reason}`,
        inline: false,
      });
    }

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
