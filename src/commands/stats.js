const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { getPool } = require('../db');
const perms = require('../perms');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Zeigt verschiedene Moderations-Statistiken.')
    .addSubcommand((sub) =>
      sub.setName('server')
        .setDescription('Zeigt serverweite Moderations-Statistiken.')
    )
    .addSubcommand((sub) =>
      sub.setName('moderator')
        .setDescription('Zeigt Statistiken für einen bestimmten Moderator.')
        .addUserOption((o) => o.setName('target').setDescription('Der Moderator').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub.setName('user')
        .setDescription('Zeigt die Moderationshistorie eines bestimmten Users.')
        .addUserOption((o) => o.setName('target').setDescription('Der User').setRequired(true))
    ),

  requiredTier: 'supporter',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    const pool = getPool();

    if (sub === 'server') {
      try {
        const [[totalRes]] = await pool.execute(
          'SELECT COUNT(*) AS total FROM infractions WHERE guild_id = ?',
          [guildId]
        );
        const totalCases = totalRes.total;

        const [typeRows] = await pool.execute(
          'SELECT type, COUNT(*) AS count FROM infractions WHERE guild_id = ? GROUP BY type',
          [guildId]
        );
        const typeBreakdown = typeRows.map((r) => `• **${r.type}**: ${r.count}`).join('\n') || 'Keine Einträge';

        const [modRows] = await pool.execute(
          'SELECT moderator_id, COUNT(*) AS count FROM infractions WHERE guild_id = ? GROUP BY moderator_id ORDER BY count DESC LIMIT 3',
          [guildId]
        );
        const topMods = modRows.map((r, i) => `${i + 1}. <@${r.moderator_id}>: ${r.count} Aktionen`).join('\n') || 'Keine Einträge';

        const [reportRows] = await pool.execute(
          'SELECT status, COUNT(*) AS count FROM reports WHERE guild_id = ? GROUP BY status',
          [guildId]
        );
        const reportsBreakdown = reportRows.map((r) => `• **${r.status}**: ${r.count}`).join('\n') || 'Keine Berichte';

        const embed = new EmbedBuilder()
          .setTitle(`📊 Server-Statistiken für ${interaction.guild.name}`)
          .setColor(0x3498db)
          .addFields(
            { name: '📂 Gesamt-Fälle (Infractions)', value: `${totalCases}`, inline: false },
            { name: '⚙️ Aktionen-Verteilung', value: typeBreakdown, inline: true },
            { name: '👮 Top Moderatoren', value: topMods, inline: true },
            { name: '📋 Berichte-Statistik', value: reportsBreakdown, inline: false }
          )
          .setFooter({ text: '🐾 Oreo • Statistiken' })
          .setTimestamp();

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      } catch (err) {
        console.error('/stats server error:', err);
        return interaction.reply({
          content: 'Fehler beim Laden der Serverstatistiken.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    if (sub === 'moderator') {
      const isMod = await perms.requireTier(interaction, 'moderator');
      if (!isMod) return;

      const targetUser = interaction.options.getUser('target') ?? interaction.user;

      try {
        const [[totalRes]] = await pool.execute(
          'SELECT COUNT(*) AS total FROM infractions WHERE guild_id = ? AND moderator_id = ?',
          [guildId, targetUser.id]
        );
        const totalActions = totalRes.total;

        const [typeRows] = await pool.execute(
          'SELECT type, COUNT(*) AS count FROM infractions WHERE guild_id = ? AND moderator_id = ? GROUP BY type',
          [guildId, targetUser.id]
        );
        const typeBreakdown = typeRows.map((r) => `• **${r.type}**: ${r.count}`).join('\n') || 'Keine Aktionen';

        const [lastActionRows] = await pool.execute(
          'SELECT type, user_id, reason, created_at, case_number FROM infractions WHERE guild_id = ? AND moderator_id = ? ORDER BY created_at DESC, case_number DESC LIMIT 1',
          [guildId, targetUser.id]
        );
        let lastActionText = 'Keine Aktionen';
        if (lastActionRows.length > 0) {
          const act = lastActionRows[0];
          const dateStr = `<t:${Math.floor(new Date(act.created_at).getTime() / 1000)}:R>`;
          lastActionText = `**Case #${act.case_number} (${act.type})** gegen <@${act.user_id}> ${dateStr}\nGrund: *${act.reason ?? 'Kein Grund angegeben'}*`;
        }

        const embed = new EmbedBuilder()
          .setTitle(`👮 Moderator-Statistik: ${targetUser.username}`)
          .setColor(0x9b59b6)
          .setThumbnail(targetUser.displayAvatarURL({ size: 128 }))
          .addFields(
            { name: '🔧 Aktionen gesamt', value: `${totalActions}`, inline: false },
            { name: '📈 Aktionstypen', value: typeBreakdown, inline: true },
            { name: '🔄 Letzte Aktion', value: lastActionText, inline: false }
          )
          .setFooter({ text: '🐾 Oreo • Statistiken' })
          .setTimestamp();

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      } catch (err) {
        console.error('/stats moderator error:', err);
        return interaction.reply({
          content: 'Fehler beim Laden der Moderatorstatistiken.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    if (sub === 'user') {
      const targetUser = interaction.options.getUser('target');

      try {
        const [[totalRes]] = await pool.execute(
          'SELECT COUNT(*) AS total FROM infractions WHERE guild_id = ? AND user_id = ?',
          [guildId, targetUser.id]
        );
        const totalInfractions = totalRes.total;

        const [typeRows] = await pool.execute(
          'SELECT type, active, COUNT(*) AS count FROM infractions WHERE guild_id = ? AND user_id = ? GROUP BY type, active',
          [guildId, targetUser.id]
        );

        let typeBreakdown = '';
        if (typeRows.length > 0) {
          typeBreakdown = typeRows.map((r) => {
            const activeText = r.active ? 'aktiv' : 'verfallen/inaktiv';
            return `• **${r.type}** (${activeText}): ${r.count}`;
          }).join('\n');
        } else {
          typeBreakdown = 'Keine registrierten Maßnahmen';
        }

        const [lastActionRows] = await pool.execute(
          'SELECT type, moderator_id, reason, created_at, case_number FROM infractions WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC, case_number DESC LIMIT 1',
          [guildId, targetUser.id]
        );
        let lastActionText = 'Keine Maßnahmen';
        if (lastActionRows.length > 0) {
          const act = lastActionRows[0];
          const dateStr = `<t:${Math.floor(new Date(act.created_at).getTime() / 1000)}:R>`;
          lastActionText = `**Case #${act.case_number} (${act.type})** von <@${act.moderator_id}> ${dateStr}\nGrund: *${act.reason ?? 'Kein Grund angegeben'}*`;
        }

        const embed = new EmbedBuilder()
          .setTitle(`👤 User-Historie: ${targetUser.username}`)
          .setColor(0xe67e22)
          .setThumbnail(targetUser.displayAvatarURL({ size: 128 }))
          .addFields(
            { name: '📂 Gesamt-Maßnahmen', value: `${totalInfractions}`, inline: false },
            { name: '📈 Maßnahmen-Typen', value: typeBreakdown, inline: true },
            { name: '🔄 Letzte Maßnahme', value: lastActionText, inline: false }
          )
          .setFooter({ text: '🐾 Oreo • Statistiken' })
          .setTimestamp();

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      } catch (err) {
        console.error('/stats user error:', err);
        return interaction.reply({
          content: 'Fehler beim Laden der User-Statistiken.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  },
};
