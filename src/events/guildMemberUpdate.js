const { Events, EmbedBuilder, AuditLogEvent } = require('discord.js');
const config = require('../config');
const { resolveAuditExecutor } = require('../auditExecutor');

async function execute(oldMember, newMember) {
  const guildId = newMember.guild.id;

  try {
    const serverLogChannelId = await config.getServerLogChannelId(guildId);
    if (!serverLogChannelId) return;

    const logChannel = await newMember.guild.channels.fetch(serverLogChannelId).catch(() => null);
    if (!logChannel) return;

    // 1. Nickname change (log_profile)
    const isProfileEnabled = await config.isLogProfileEnabled(guildId);
    if (isProfileEnabled && oldMember.nickname !== newMember.nickname) {
      const oldNick = oldMember.nickname ?? '(Keiner)';
      const newNick = newMember.nickname ?? '(Keiner)';

      const nickAuditResult = await resolveAuditExecutor(newMember.guild, AuditLogEvent.MemberUpdate, newMember.user.id, {
        filter: entry => entry.changes.some(c => c.key === 'nick'),
        logContext: '[roles-profile-log] Failed to fetch audit logs for nickname change:',
      });
      const executorTag = nickAuditResult?.executorTag ?? null;

      const embed = new EmbedBuilder()
        .setTitle('👤 Nickname geändert')
        .setColor(0x3498db)
        .addFields(
          { name: '👤 User', value: `<@${newMember.user.id}> (${newMember.user.tag})`, inline: true },
          { name: '🆔 User-ID', value: newMember.user.id, inline: true }
        );

      if (executorTag) {
        embed.addFields({ name: '✍️ Geändert von', value: executorTag, inline: true });
      }

      embed.addFields(
        { name: 'Vorher', value: oldNick, inline: true },
        { name: 'Nachher', value: newNick, inline: true }
      )
      .setTimestamp();
      await logChannel.send({ embeds: [embed] }).catch(() => null);
    }

    // 2. Role changes (log_roles)
    const isRolesEnabled = await config.isLogRolesEnabled(guildId);
    if (isRolesEnabled) {
      const oldRoles = oldMember.roles.cache;
      const newRoles = newMember.roles.cache;

      const added = [...newRoles.values()].filter(r => !oldRoles.has(r.id));
      const removed = [...oldRoles.values()].filter(r => !newRoles.has(r.id));

      if (added.length > 0 || removed.length > 0) {
        const roleAuditResult = await resolveAuditExecutor(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.user.id, {
          logContext: '[roles-profile-log] Failed to fetch audit logs for role update:',
        });
        const executorTag = roleAuditResult?.executorTag ?? null;

        const embed = new EmbedBuilder()
          .setTitle('🛡️ Rollen geändert')
          .setColor(0x9b59b6)
          .addFields(
            { name: '👤 User', value: `<@${newMember.user.id}> (${newMember.user.tag})`, inline: true },
            { name: '🆔 User-ID', value: newMember.user.id, inline: true }
          );

        if (executorTag) {
          embed.addFields({ name: '✍️ Geändert von', value: executorTag, inline: true });
        }

        embed.setTimestamp();

        if (added.length > 0) {
          embed.addFields({ name: '➕ Hinzugefügt', value: added.map(r => `<@&${r.id}>`).join(', '), inline: false });
        }
        if (removed.length > 0) {
          embed.addFields({ name: '➖ Entfernt', value: removed.map(r => `<@&${r.id}>`).join(', '), inline: false });
        }
        await logChannel.send({ embeds: [embed] }).catch(() => null);
      }
    }
  } catch (err) {
    console.error('[roles-profile-log] guildMemberUpdate failed:', err);
  }
}

module.exports = {
  name: Events.GuildMemberUpdate,
  execute,
};
