const { Events, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const config = require('../config');

async function execute(messages) {
  if (messages.size === 0) return;
  
  const sampleMessage = messages.first();
  const guild = sampleMessage?.guild;
  if (!guild) return;

  try {
    const isMessagesEnabled = await config.isLogMessagesEnabled(guild.id);
    if (!isMessagesEnabled) return;

    const channelId = await config.getMsgLogChannelId(guild.id);
    if (!channelId) return;

    const logChannel = await guild.channels.fetch(channelId).catch(() => null);
    if (!logChannel) return;

    const channel = sampleMessage.channel;
    
    // Sort messages chronologically
    const sortedMessages = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    // Format logs into string
    let logText = `=== BULK MESSAGE DELETE LOG ===\n`;
    logText += `Guild: ${guild.name} (${guild.id})\n`;
    logText += `Channel: #${channel.name} (${channel.id})\n`;
    logText += `Amount Deleted: ${messages.size}\n`;
    logText += `Timestamp: ${new Date().toISOString()}\n`;
    logText += `=================================\n\n`;

    for (const msg of sortedMessages) {
      const authorTag = msg.author ? `${msg.author.tag} (${msg.author.id})` : 'Unknown User';
      const timestamp = new Date(msg.createdTimestamp).toISOString();
      const content = msg.content || '(Empty content / Embeds only / Cached without content)';
      
      logText += `[${timestamp}] ${authorTag}:\n`;
      logText += `${content}\n`;
      
      if (msg.attachments && msg.attachments.size > 0) {
        logText += `Attachments: ${[...msg.attachments.values()].map((a) => `${a.name} (${a.url})`).join(', ')}\n`;
      }
      logText += `---------------------------------\n`;
    }

    const fileBuffer = Buffer.from(logText, 'utf-8');
    const attachment = new AttachmentBuilder(fileBuffer, { name: `bulk_delete_${channel.name}_${Date.now()}.txt` });

    const embed = new EmbedBuilder()
      .setTitle('🗑️ Bulk-Nachrichten gelöscht')
      .setColor(0xed4245)
      .addFields(
        { name: '📺 Channel', value: `<#${channel.id}> (#${channel.name})`, inline: true },
        { name: '🔢 Anzahl gelöscht', value: `${messages.size}`, inline: true }
      )
      .setFooter({ text: '🐾 Oreo' })
      .setTimestamp();

    await logChannel.send({ embeds: [embed], files: [attachment] }).catch(() => null);
  } catch (err) {
    console.error('[msg-log] failed to log bulk message delete:', err);
  }
}

module.exports = {
  name: Events.MessageDeleteBulk,
  execute,
};
