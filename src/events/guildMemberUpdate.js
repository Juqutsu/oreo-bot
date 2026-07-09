const { Events, EmbedBuilder, AuditLogEvent } = require('discord.js');
const config = require('../config');
const { resolveAuditExecutor } = require('../auditExecutor');
const verifications = require('../verifications');

/**
 * Pure decision core — no DB/Discord I/O, unit-testable.
 * Returns whether the member should now be treated as verified and which
 * unverified role ids to strip (only those the member currently has).
 */
function decideVerification({ isBot, oldRoleIds, newRoleIds, verifiedRoleIds, unverifiedRoleIds, oldPartial }) {
  if (isBot) return { verify: false, removeUnverified: [] };

  const verifiedSet = new Set(verifiedRoleIds);
  const hasVerifiedNow = newRoleIds.some((id) => verifiedSet.has(id));
  if (!hasVerifiedNow) return { verify: false, removeUnverified: [] };

  // If the old (cached) state already had a verified role, nothing new happened.
  // When oldMember is partial we can't diff, so we reconcile (idempotent).
  const hadVerifiedBefore = !oldPartial && oldRoleIds.some((id) => verifiedSet.has(id));
  if (hadVerifiedBefore) return { verify: false, removeUnverified: [] };

  const newSet = new Set(newRoleIds);
  const removeUnverified = unverifiedRoleIds.filter((id) => newSet.has(id));
  return { verify: true, removeUnverified };
}

async function execute(oldMember, newMember) {
  if (!newMember) return;

  const guildId = newMember.guild.id;

  // Handle manual verified-role assignment (manual-verify feature).
  // Own try/catch so a feature-side failure can never suppress the server-logging below.
  try {
    const verifiedRoleIds = await config.getVerifiedRoleIds(guildId);
    if (verifiedRoleIds.length > 0) {
      const unverifiedRoleIds = await config.getUnverifiedRoleIds(guildId);

      const oldPartial = oldMember?.partial === true;
      const oldRoleIds = oldPartial ? [] : [...(oldMember?.roles?.cache?.keys() ?? [])];
      const newRoleIds = [...(newMember.roles?.cache?.keys() ?? [])];

      const { verify, removeUnverified } = decideVerification({
        isBot: newMember.user?.bot === true,
        oldRoleIds,
        newRoleIds,
        verifiedRoleIds,
        unverifiedRoleIds,
        oldPartial,
      });
      if (verify) {
        // 1. Clear the verification deadline so the background sweep won't kick them.
        await verifications.markVerified(guildId, newMember.id).catch((err) =>
          console.error('[manual-verify] markVerified failed:', err));

        // 2. Strip the unverified role(s) so the state matches a captcha-verified member.
        for (const rId of removeUnverified) {
          const role = newMember.guild.roles.cache.get(rId)
            || await newMember.guild.roles.fetch(rId).catch(() => null);
          if (role) {
            await newMember.roles.remove(role, 'Oreo: Manuell verifiziert').catch((err) =>
              console.error('[manual-verify] removing unverified role failed:', err));
          }
        }
      }
    }
  } catch (err) {
    console.error('[manual-verify] guildMemberUpdate feature failed:', err);
  }

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
  _internal: { decideVerification },
};
