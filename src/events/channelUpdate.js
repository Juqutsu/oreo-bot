const { Events, EmbedBuilder, AuditLogEvent } = require('discord.js');
const config = require('../config');
const { resolveAuditExecutor } = require('../auditExecutor');

async function execute(oldChannel, newChannel) {
  if (!newChannel.guild) return;
  const guildId = newChannel.guild.id;

  try {
    const serverLogChannelId = await config.getServerLogChannelId(guildId);
    if (!serverLogChannelId) return;

    const logChannel = await newChannel.guild.channels.fetch(serverLogChannelId).catch(() => null);
    if (!logChannel) return;

    const nameChanged = oldChannel.name !== newChannel.name;
    const parentChanged = oldChannel.parentId !== newChannel.parentId;
    const nsfwChanged = oldChannel.nsfw !== newChannel.nsfw;
    const slowmodeChanged = oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser;
    const topicChanged = oldChannel.topic !== newChannel.topic;

    if (!nameChanged && !parentChanged && !nsfwChanged && !slowmodeChanged && !topicChanged) return;

    const auditResult = await resolveAuditExecutor(newChannel.guild, AuditLogEvent.ChannelUpdate, newChannel.id, {
      logContext: '[channel-log] Failed to fetch audit logs for channel update:',
    });
    const executorTag = auditResult?.executorTag ?? null;

    const embed = new EmbedBuilder()
      .setTitle('📺 Channel bearbeitet')
      .setColor(0x3498db)
      .addFields(
        { name: '📺 Kanal', value: `<#${newChannel.id}>`, inline: true },
        { name: '🆔 Kanal-ID', value: newChannel.id, inline: true }
      )
      .setTimestamp()
      .setFooter({ text: '🐾 Oreo' });

    if (executorTag) {
      embed.addFields({ name: '✍️ Geändert von', value: executorTag, inline: true });
    }

    if (nameChanged) {
      embed.addFields(
        { name: '📝 Name (vorher)', value: oldChannel.name, inline: true },
        { name: '📝 Name (nachher)', value: newChannel.name, inline: true },
        { name: '\u200b', value: '\u200b', inline: true }
      );
    }

    if (parentChanged) {
      const oldParent = oldChannel.parent ? oldChannel.parent.name : 'Keine';
      const newParent = newChannel.parent ? newChannel.parent.name : 'Keine';
      embed.addFields(
        { name: '🗂️ Kategorie (vorher)', value: oldParent, inline: true },
        { name: '🗂️ Kategorie (nachher)', value: newParent, inline: true },
        { name: '\u200b', value: '\u200b', inline: true }
      );
    }

    if (nsfwChanged) {
      embed.addFields(
        { name: '🔞 NSFW (vorher)', value: oldChannel.nsfw ? 'Ja' : 'Nein', inline: true },
        { name: '🔞 NSFW (nachher)', value: newChannel.nsfw ? 'Ja' : 'Nein', inline: true },
        { name: '\u200b', value: '\u200b', inline: true }
      );
    }

    if (slowmodeChanged) {
      embed.addFields(
        { name: '⏱️ Slowmode (vorher)', value: `${oldChannel.rateLimitPerUser}s`, inline: true },
        { name: '⏱️ Slowmode (nachher)', value: `${newChannel.rateLimitPerUser}s`, inline: true },
        { name: '\u200b', value: '\u200b', inline: true }
      );
    }

    if (topicChanged) {
      const oldTopic = oldChannel.topic || '(Kein Thema)';
      const newTopic = newChannel.topic || '(Kein Thema)';
      embed.addFields(
        { name: '💬 Thema (vorher)', value: oldTopic.length > 250 ? `${oldTopic.slice(0, 247)}...` : oldTopic, inline: false },
        { name: '💬 Thema (nachher)', value: newTopic.length > 250 ? `${newTopic.slice(0, 247)}...` : newTopic, inline: false }
      );
    }

    await logChannel.send({ embeds: [embed] }).catch(() => null);
  } catch (err) {
    console.error('[channel-log] channelUpdate failed:', err);
  }
}

module.exports = {
  name: Events.ChannelUpdate,
  execute,
};
