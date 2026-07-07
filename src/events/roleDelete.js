const { Events, EmbedBuilder, AuditLogEvent } = require('discord.js');
const config = require('../config');
const { resolveAuditExecutor } = require('../auditExecutor');

async function execute(role) {
  const guildId = role.guild.id;

  try {
    const isRolesEnabled = await config.isLogRolesEnabled(guildId);
    if (!isRolesEnabled) return;

    const serverLogChannelId = await config.getServerLogChannelId(guildId);
    if (!serverLogChannelId) return;

    const logChannel = await role.guild.channels.fetch(serverLogChannelId).catch(() => null);
    if (!logChannel) return;

    const auditResult = await resolveAuditExecutor(role.guild, AuditLogEvent.RoleDelete, role.id, {
      logContext: '[role-log] Failed to fetch audit logs for role delete:',
    });
    const executorTag = auditResult?.executorTag ?? null;

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
