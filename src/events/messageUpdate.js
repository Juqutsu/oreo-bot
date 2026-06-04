const { Events, EmbedBuilder } = require('discord.js');
const config = require('../config');

async function execute(oldMessage, newMessage) {
  // Ignore DMs and messages sent by bots (if known)
  if (!newMessage.guild) return;
  if (newMessage.author?.bot) return;

  // Guard: ignore if content is identical (e.g., message was pinned or embed fetched)
  if (oldMessage.content === newMessage.content) return;

  try {
    const channelId = await config.getMsgLogChannelId(newMessage.guild.id);
    if (!channelId) return;

    const logChannel = await newMessage.guild.channels.fetch(channelId).catch(() => null);
    if (!logChannel) return;

    const author = newMessage.author ?? oldMessage.author;
    const userLine = author 
      ? `<@${author.id}> (${author.globalName ?? author.username})` 
      : 'Unbekannter User';

    const embed = new EmbedBuilder()
      .setTitle('📝 Nachricht bearbeitet')
      .setColor(0x5865f2)
      .addFields(
        { name: '👤 User', value: userLine, inline: false },
        { name: '📺 Channel', value: `<#${newMessage.channel.id}>`, inline: false }
      )
      .setFooter({ text: '🐾 Oreo' })
      .setTimestamp();

    const truncate = (str) => str.length > 1000 ? `${str.slice(0, 997)}…` : str;

    if (oldMessage.content) {
      embed.addFields({ name: 'Alt', value: truncate(oldMessage.content), inline: false });
    } else {
      embed.addFields({ name: 'Alt', value: '*(Inhalt nicht im Cache)*', inline: false });
    }

    if (newMessage.content) {
      embed.addFields({ name: 'Neu', value: truncate(newMessage.content), inline: false });
    } else {
      embed.addFields({ name: 'Neu', value: '*(Leere Nachricht)*', inline: false });
    }

    await logChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[msg-log] failed to log edited message:', err);
  }
}

module.exports = {
  name: Events.MessageUpdate,
  execute,
};
