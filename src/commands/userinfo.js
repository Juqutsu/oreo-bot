const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { getPool } = require('../db');

const MAX_ROLES_DISPLAYED = 10;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Zeigt Informationen über einen User (Account, Server, Cases).')
    .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),

  requiredTier: 'supporter',

  async execute(interaction) {
    const user = interaction.options.getUser('user');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    // DB-Query: aggregate case counts by type + active
    let caseStats = { warnActive: 0, warnTotal: 0, timeoutTotal: 0, kickTotal: 0, banTotal: 0 };
    try {
      const [rows] = await getPool().execute(
        `SELECT type, active, COUNT(*) AS count
           FROM infractions
          WHERE guild_id = ? AND user_id = ?
          GROUP BY type, active`,
        [interaction.guildId, user.id],
      );
      for (const row of rows) {
        const count = Number(row.count);
        if (row.type === 'warn') {
          caseStats.warnTotal += count;
          if (row.active) caseStats.warnActive += count;
        } else if (row.type === 'timeout') {
          caseStats.timeoutTotal += count;
        } else if (row.type === 'kick') {
          caseStats.kickTotal += count;
        } else if (row.type === 'ban') {
          caseStats.banTotal += count;
        }
      }
    } catch (err) {
      console.error('/userinfo DB error:', err);
      return interaction.reply({
        content: 'Datenbankfehler — versuch es später.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const createdSec = Math.floor(user.createdTimestamp / 1000);

    // Roles field (only if member)
    let rolesValue = '—';
    if (member) {
      const roles = member.roles.cache
        .filter((r) => r.id !== interaction.guildId) // exclude @everyone
        .sort((a, b) => b.position - a.position)
        .map((r) => `<@&${r.id}>`);
      if (roles.length === 0) {
        rolesValue = '—';
      } else if (roles.length <= MAX_ROLES_DISPLAYED) {
        rolesValue = roles.join(', ');
      } else {
        rolesValue = `${roles.slice(0, MAX_ROLES_DISPLAYED).join(', ')} (+${roles.length - MAX_ROLES_DISPLAYED} weitere)`;
      }
    }

    // Server-join field
    let joinValue;
    if (member?.joinedTimestamp) {
      const joinedSec = Math.floor(member.joinedTimestamp / 1000);
      joinValue = `<t:${joinedSec}:f> (<t:${joinedSec}:R>)`;
    } else {
      joinValue = 'nicht auf dem Server';
    }

    // Cases field (multi-line)
    const casesValue = [
      `⚠️ Warns: ${caseStats.warnTotal} (${caseStats.warnActive} aktiv)`,
      `⏱️ Timeouts: ${caseStats.timeoutTotal}`,
      `👢 Kicks: ${caseStats.kickTotal}`,
      `🔨 Bans: ${caseStats.banTotal}`,
    ].join('\n');

    const embed = new EmbedBuilder()
      .setTitle(`👤 ${user.tag}`)
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .setColor(0x5865f2)
      .addFields(
        { name: '🆔 User-ID', value: user.id, inline: true },
        { name: '📅 Account erstellt', value: `<t:${createdSec}:f> (<t:${createdSec}:R>)`, inline: true },
        { name: '🚪 Server-Beitritt', value: joinValue, inline: true },
        { name: '🎭 Rollen', value: rolesValue, inline: false },
        { name: '⚖️ Cases', value: casesValue, inline: false },
      )
      .setFooter({ text: '🐾 Oreo' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
