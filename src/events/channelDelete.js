const { Events, EmbedBuilder, AuditLogEvent, ChannelType } = require('discord.js');
const config = require('../config');

const CHANNEL_TYPE_LABELS = {
  [ChannelType.GuildText]: 'Textkanal',
  [ChannelType.GuildVoice]: 'Voicekanal',
  [ChannelType.GuildCategory]: 'Kategorie',
  [ChannelType.GuildAnnouncement]: 'Ankündigungskanal',
  [ChannelType.GuildStageVoice]: 'Stage-Kanal',
  [ChannelType.GuildForum]: 'Forum',
  [ChannelType.GuildMedia]: 'Medienkanal',
};

async function execute(channel) {
  if (!channel.guild) return;
  const guildId = channel.guild.id;

  try {
    const serverLogChannelId = await config.getServerLogChannelId(guildId);
    if (!serverLogChannelId) return;

    const logChannel = await channel.guild.channels.fetch(serverLogChannelId).catch(() => null);
    if (!logChannel) return;

    let executorTag = null;
    try {
      const auditLogs = await channel.guild.fetchAuditLogs({
        type: AuditLogEvent.ChannelDelete,
        limit: 5,
      });
      const logEntry = [...auditLogs.entries.values()].find(
        entry => entry.targetId === channel.id &&
                 (Date.now() - entry.createdTimestamp) < 10000
      );
      if (logEntry && logEntry.executor) {
        executorTag = `<@${logEntry.executor.id}> (${logEntry.executor.tag})`;
      }
    } catch (err) {
      console.warn('[channel-log] Failed to fetch audit logs for channel delete:', err);
    }

    const typeLabel = CHANNEL_TYPE_LABELS[channel.type] ?? 'Unbekannt';
    const parentLabel = channel.parent ? `${channel.parent.name}` : 'Keine';

    const embed = new EmbedBuilder()
      .setTitle('🗑️ Channel gelöscht')
      .setColor(0xe74c3c)
      .addFields(
        { name: '👤 Kanalname', value: `${channel.name}`, inline: true },
        { name: '🆔 Kanal-ID', value: channel.id, inline: true }
      )
      .setTimestamp()
      .setFooter({ text: '🐾 Oreo' });

    if (executorTag) {
      embed.addFields({ name: '✍️ Gelöscht von', value: executorTag, inline: true });
    }

    embed.addFields(
      { name: '📁 Typ', value: typeLabel, inline: true },
      { name: '🗂️ Kategorie', value: parentLabel, inline: true }
    );

    await logChannel.send({ embeds: [embed] }).catch(() => null);
  } catch (err) {
    console.error('[channel-log] channelDelete failed:', err);
  }
}

module.exports = {
  name: Events.ChannelDelete,
  execute,
};
