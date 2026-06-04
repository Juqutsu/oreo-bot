const { Events, EmbedBuilder } = require('discord.js');
const config = require('../config');

async function execute(message) {
  // Ignore DMs and messages sent by bots (if known)
  if (!message.guild) return;
  if (message.author?.bot) return;

  try {
    const channelId = await config.getMsgLogChannelId(message.guild.id);
    if (!channelId) return;

    const logChannel = await message.guild.channels.fetch(channelId).catch(() => null);
    if (!logChannel) return;

    const userLine = message.author 
      ? `<@${message.author.id}> (${message.author.globalName ?? message.author.username})` 
      : 'Unbekannter User';

    const embed = new EmbedBuilder()
      .setTitle('🗑️ Nachricht gelöscht')
      .setColor(0xed4245)
      .addFields(
        { name: '👤 User', value: userLine, inline: false },
        { name: '📺 Channel', value: `<#${message.channel.id}>`, inline: false }
      )
      .setFooter({ text: '🐾 Oreo' })
      .setTimestamp();

    if (message.content) {
      const contentVal = message.content.length > 1000 
        ? `${message.content.slice(0, 997)}…` 
        : message.content;
      embed.addFields({ name: '📝 Inhalt', value: contentVal, inline: false });
    } else {
      embed.addFields({ name: '📝 Inhalt', value: '*(Inhalt nicht im Cache)*', inline: false });
    }

    if (message.attachments && message.attachments.size > 0) {
      const attachmentList = [...message.attachments.values()].map((a) => `\`${a.name}\``).join(', ');
      const val = attachmentList.length > 1000 
        ? `${message.attachments.size} Anhänge` 
        : attachmentList;
      embed.addFields({ name: '📎 Anhänge', value: val, inline: false });
    }

    await logChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[msg-log] failed to log deleted message:', err);
  }
}

module.exports = {
  name: Events.MessageDelete,
  execute,
};
