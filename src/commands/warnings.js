const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const cases = require('../cases');
const perms = require('../perms');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('Zeigt die Verwarnungen eines Users.')
    .addUserOption((option) => option.setName('target').setDescription('Wessen Verwarnungen? (Standard: du selbst)').setRequired(false))
    .addBooleanOption((option) => option.setName('include_inactive').setDescription('Auch entfernte Verwarnungen zeigen').setRequired(false)),

  async execute(interaction) {
    const target = interaction.options.getUser('target') ?? interaction.user;
    const includeInactive = interaction.options.getBoolean('include_inactive') ?? false;

    if (target.id !== interaction.user.id) {
      const allowed = await perms.hasTier(interaction.guildId, interaction.member, 'supporter').catch(() => false);
      if (!allowed) {
        return interaction.reply({
          content: '❌ Du kannst nur deine eigenen Verwarnungen einsehen.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    let warns;
    let activeCount;
    try {
      warns = await cases.listWarnings(interaction.guildId, target.id, { includeInactive, limit: 25 });
      activeCount = await cases.countActiveWarnings(interaction.guildId, target.id);
    } catch (err) {
      console.error('listWarnings failed:', err);
      return interaction.reply({
        content: 'Datenbankfehler — versuch es später nochmal.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (warns.length === 0) {
      return interaction.reply({
        content: `**${target.username}** hat keine ${includeInactive ? '' : 'aktiven '}Verwarnungen.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(`⚠️ Verwarnungen von ${target.username}`)
      .setColor(0xfaa61a)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .setFooter({ text: `Aktive: ${activeCount} · Gesamt angezeigt: ${warns.length} · 🐾` })
      .setTimestamp();

    for (const w of warns) {
      const date = new Date(w.created_at);
      const dateStr = `<t:${Math.floor(date.getTime() / 1000)}:f>`;
      const reason = w.reason ?? 'Kein Grund angegeben';
      const activeBadge = w.active ? '' : ' [ENTFERNT]';
      embed.addFields({
        name: `Case #${w.case_number}${activeBadge}`,
        value: `${dateStr}\nvon <@${w.moderator_id}>\n${reason}`,
        inline: false,
      });
    }

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
