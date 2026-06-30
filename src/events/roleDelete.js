const { Events, EmbedBuilder, AuditLogEvent } = require('discord.js');
const config = require('../config');

async function execute(role) {
  const guildId = role.guild.id;

  try {
    const isRolesEnabled = await config.isLogRolesEnabled(guildId);
    if (!isRolesEnabled) return;

    const serverLogChannelId = await config.getServerLogChannelId(guildId);
    if (!serverLogChannelId) return;

    const logChannel = await role.guild.channels.fetch(serverLogChannelId).catch(() => null);
    if (!logChannel) return;

    let executorTag = null;
    try {
      const auditLogs = await role.guild.fetchAuditLogs({
        type: AuditLogEvent.RoleDelete,
        limit: 5,
      });
      const logEntry = [...auditLogs.entries.values()].find(
        entry => entry.targetId === role.id &&
                 (Date.now() - entry.createdTimestamp) < 10000
      );
      if (logEntry && logEntry.executor) {
        executorTag = `<@${logEntry.executor.id}> (${logEntry.executor.tag})`;
      }
    } catch (err) {
      console.warn('[role-log] Failed to fetch audit logs for role delete:', err);
    }

    const embed = new EmbedBuilder()
      .setTitle('🛡️ Rolle gelöscht')
      .setColor(0xe74c3c)
      .addFields(
        { name: '👤 Rollenname', value: `${role.name}`, inline: true },
        { name: '🆔 Rollen-ID', value: role.id, inline: true }
      )
      .setTimestamp()
      .setFooter({ text: '🐾 Oreo' });

    if (executorTag) {
      embed.addFields({ name: '✍️ Gelöscht von', value: executorTag, inline: true });
    }

    await logChannel.send({ embeds: [embed] }).catch(() => null);
  } catch (err) {
    console.error('[role-log] roleDelete failed:', err);
  }
}

module.exports = {
  name: Events.GuildRoleDelete,
  execute,
};
