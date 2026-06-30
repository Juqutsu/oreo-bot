const { Events, EmbedBuilder, AuditLogEvent } = require('discord.js');
const config = require('../config');

async function execute(oldRole, newRole) {
  const guildId = newRole.guild.id;

  try {
    const isRolesEnabled = await config.isLogRolesEnabled(guildId);
    if (!isRolesEnabled) return;

    const serverLogChannelId = await config.getServerLogChannelId(guildId);
    if (!serverLogChannelId) return;

    const logChannel = await newRole.guild.channels.fetch(serverLogChannelId).catch(() => null);
    if (!logChannel) return;

    // Check if there are actual updates we want to log
    const nameChanged = oldRole.name !== newRole.name;
    const colorChanged = oldRole.hexColor !== newRole.hexColor;
    const hoistChanged = oldRole.hoist !== newRole.hoist;
    const mentionChanged = oldRole.mentionable !== newRole.mentionable;
    
    const addedPerms = newRole.permissions.missing(oldRole.permissions);
    const removedPerms = oldRole.permissions.missing(newRole.permissions);
    const permissionsChanged = addedPerms.length > 0 || removedPerms.length > 0;

    if (!nameChanged && !colorChanged && !hoistChanged && !mentionChanged && !permissionsChanged) return;

    let executorTag = null;
    try {
      const auditLogs = await newRole.guild.fetchAuditLogs({
        type: AuditLogEvent.RoleUpdate,
        limit: 5,
      });
      const logEntry = [...auditLogs.entries.values()].find(
        entry => entry.targetId === newRole.id &&
                 (Date.now() - entry.createdTimestamp) < 10000
      );
      if (logEntry && logEntry.executor) {
        executorTag = `<@${logEntry.executor.id}> (${logEntry.executor.tag})`;
      }
    } catch (err) {
      console.warn('[role-log] Failed to fetch audit logs for role update:', err);
    }

    const embed = new EmbedBuilder()
      .setTitle('🛡️ Rolle bearbeitet')
      .setColor(0x9b59b6)
      .addFields(
        { name: '👤 Rolle', value: `<@&${newRole.id}>`, inline: true },
        { name: '🆔 Rollen-ID', value: newRole.id, inline: true }
      )
      .setTimestamp()
      .setFooter({ text: '🐾 Oreo' });

    if (executorTag) {
      embed.addFields({ name: '✍️ Geändert von', value: executorTag, inline: true });
    }

    if (nameChanged) {
      embed.addFields(
        { name: '📝 Name (vorher)', value: oldRole.name, inline: true },
        { name: '📝 Name (nachher)', value: newRole.name, inline: true },
        { name: '\u200b', value: '\u200b', inline: true }
      );
    }

    if (colorChanged) {
      embed.addFields(
        { name: '🎨 Farbe (vorher)', value: oldRole.hexColor, inline: true },
        { name: '🎨 Farbe (nachher)', value: newRole.hexColor, inline: true },
        { name: '\u200b', value: '\u200b', inline: true }
      );
    }

    if (hoistChanged) {
      embed.addFields(
        { name: '📌 Separat (vorher)', value: oldRole.hoist ? 'Ja' : 'Nein', inline: true },
        { name: '📌 Separat (nachher)', value: newRole.hoist ? 'Ja' : 'Nein', inline: true },
        { name: '\u200b', value: '\u200b', inline: true }
      );
    }

    if (mentionChanged) {
      embed.addFields(
        { name: '🔔 Erwähnbar (vorher)', value: oldRole.mentionable ? 'Ja' : 'Nein', inline: true },
        { name: '🔔 Erwähnbar (nachher)', value: newRole.mentionable ? 'Ja' : 'Nein', inline: true },
        { name: '\u200b', value: '\u200b', inline: true }
      );
    }

    if (permissionsChanged) {
      if (addedPerms.length > 0) {
        embed.addFields({ name: '➕ Hinzugefügte Berechtigungen', value: addedPerms.join(', '), inline: false });
      }
      if (removedPerms.length > 0) {
        embed.addFields({ name: '➖ Entzogene Berechtigungen', value: removedPerms.join(', '), inline: false });
      }
    }

    await logChannel.send({ embeds: [embed] }).catch(() => null);
  } catch (err) {
    console.error('[role-log] roleUpdate failed:', err);
  }
}

module.exports = {
  name: Events.GuildRoleUpdate,
  execute,
};
