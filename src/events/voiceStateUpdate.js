const { Events, EmbedBuilder } = require('discord.js');
const config = require('../config');

async function execute(oldState, newState) {
  const guildId = newState.guild.id;

  try {
    const isVoiceEnabled = await config.isLogVoiceEnabled(guildId);
    if (!isVoiceEnabled) return;

    const serverLogChannelId = await config.getServerLogChannelId(guildId);
    if (!serverLogChannelId) return;

    const logChannel = await newState.guild.channels.fetch(serverLogChannelId).catch(() => null);
    if (!logChannel) return;

    const member = newState.member;
    if (!member) return;

    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    if (oldChannelId !== newChannelId) {
      const embed = new EmbedBuilder()
        .setColor(0x1abc9c)
        .setTimestamp();

      if (!oldChannelId && newChannelId) {
        // Joined channel
        embed.setTitle('🔊 Voice-Kanal beigetreten')
          .addFields(
            { name: '👤 User', value: `<@${member.user.id}> (${member.user.tag})`, inline: true },
            { name: '🆔 User-ID', value: member.user.id, inline: true },
            { name: '📢 Kanal', value: `<#${newChannelId}>`, inline: false }
          );
        await logChannel.send({ embeds: [embed] }).catch(() => null);
      } else if (oldChannelId && !newChannelId) {
        // Left channel
        embed.setTitle('🔇 Voice-Kanal verlassen')
          .setColor(0xe67e22)
          .addFields(
            { name: '👤 User', value: `<@${member.user.id}> (${member.user.tag})`, inline: true },
            { name: '🆔 User-ID', value: member.user.id, inline: true },
            { name: '📢 Kanal', value: `<#${oldChannelId}>`, inline: false }
          );
        await logChannel.send({ embeds: [embed] }).catch(() => null);
      } else if (oldChannelId && newChannelId) {
        // Switched channel
        embed.setTitle('🔀 Voice-Kanal gewechselt')
          .addFields(
            { name: '👤 User', value: `<@${member.user.id}> (${member.user.tag})`, inline: true },
            { name: '🆔 User-ID', value: member.user.id, inline: true },
            { name: 'Von', value: `<#${oldChannelId}>`, inline: true },
            { name: 'Nach', value: `<#${newChannelId}>`, inline: true }
          );
        await logChannel.send({ embeds: [embed] }).catch(() => null);
      }
    }
  } catch (err) {
    console.error('[voice-log] voiceStateUpdate failed:', err);
  }
}

module.exports = {
  name: Events.VoiceStateUpdate,
  execute,
};
