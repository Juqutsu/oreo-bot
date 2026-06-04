const { Events, AuditLogEvent } = require('discord.js');
const cases = require('../cases');
const config = require('../config');
const { buildModLogEmbed } = require('../modlog');

async function execute(entry, guild) {
  // 1. Filter out actions performed by the bot itself to prevent duplicate logging.
  if (entry.executorId === guild.client.user.id) return;

  let type = null;
  let actionLabel = null;
  let durationMs = null;
  let expiresAt = null;

  if (entry.action === AuditLogEvent.MemberBanAdd) {
    type = 'ban';
    actionLabel = 'ban';
  } else if (entry.action === AuditLogEvent.MemberBanRemove) {
    type = 'unban';
    actionLabel = 'unban';
  } else if (entry.action === AuditLogEvent.MemberKick) {
    type = 'kick';
    actionLabel = 'kick';
  } else if (entry.action === AuditLogEvent.MemberUpdate) {
    const change = entry.changes.find((c) => c.key === 'communication_disabled_until');
    if (change) {
      if (change.new) {
        type = 'timeout';
        actionLabel = 'timeout';
        expiresAt = new Date(change.new);
        durationMs = expiresAt.getTime() - entry.createdAt.getTime();
        // If durationMs is negative due to slight clock drift, normalize to 0
        if (durationMs < 0) durationMs = 0;
      } else {
        type = 'untimeout';
        actionLabel = 'untimeout';
      }
    }
  }

  // If this audit log entry is not one of our tracked moderation actions, ignore it.
  if (!type) return;

  // 2. Persist case (fail-soft).
  let caseNumber = null;
  try {
    const result = await cases.createCase({
      guildId: guild.id,
      userId: entry.targetId,
      moderatorId: entry.executorId,
      type,
      reason: entry.reason,
      durationMs,
      expiresAt,
      source: 'manual',
    });
    caseNumber = result.caseNumber;
  } catch (err) {
    console.error('[audit-mirror] failed to persist case:', err);
  }

  // 3. Post mod-log (fail-soft).
  try {
    const modLogChannelId = await config.getModLogChannelId(guild.id);
    if (!modLogChannelId) return;

    const channel = await guild.channels.fetch(modLogChannelId).catch(() => null);
    if (!channel) return;

    // Fetch moderator and target users to ensure we have complete objects for the embed.
    const [targetUser, moderatorUser] = await Promise.all([
      guild.client.users.fetch(entry.targetId).catch(() => null),
      guild.client.users.fetch(entry.executorId).catch(() => null),
    ]);

    if (!targetUser || !moderatorUser) {
      console.warn('[audit-mirror] failed to fetch target or moderator user info');
      return;
    }

    const embed = buildModLogEmbed({
      action: actionLabel,
      caseNumber,
      target: targetUser,
      mod: moderatorUser,
      reason: entry.reason,
      durationMs,
    });

    if (embed) {
      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error('[audit-mirror] failed to post mod-log:', err);
  }
}

module.exports = {
  name: Events.GuildAuditLogEntryCreate,
  execute,
};
