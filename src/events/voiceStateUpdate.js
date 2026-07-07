const { Events, EmbedBuilder, AuditLogEvent } = require('discord.js');
const config = require('../config');
const { resolveAuditExecutor } = require('../auditExecutor');

async function execute(oldState, newState) {
  const guildId = newState.guild.id;

  try {
    // Auto-leave if bot is alone in voice channel
    const { getVoiceConnection } = require('@discordjs/voice');
    const connection = getVoiceConnection(guildId);
    if (connection && connection.joinConfig.channelId) {
      const botChannelId = connection.joinConfig.channelId;
      const oldChannelId = oldState.channelId;
      const newChannelId = newState.channelId;
      
      if (oldChannelId === botChannelId && oldChannelId !== newChannelId) {
        const botChannel = await newState.guild.channels.fetch(botChannelId).catch(() => null);
        if (botChannel) {
          const humans = botChannel.members.filter(m => !m.user.bot);
          if (humans.size === 0) {
            connection.destroy();
            console.log(`[voice-rec] Left voice channel ${botChannel.name} because it is empty.`);
            const voiceRecChannelId = await config.getVoiceRecChannelId(guildId);
            if (voiceRecChannelId) {
              const textChannel = await newState.guild.channels.fetch(voiceRecChannelId).catch(() => null);
              if (textChannel) {
                await textChannel.send(`🐕 **Oreo Auto-Standby:** Ich habe den Voice-Kanal **${botChannel.name}** verlassen, da keine Personen mehr anwesend waren.`);
              }
            }
          }
        }
      }
    }

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
        const disconnectAuditResult = await resolveAuditExecutor(newState.guild, AuditLogEvent.MemberDisconnect, member.user.id, {
          logContext: '[voice-log] Failed to fetch audit logs for disconnect:',
        });
        const executorTag = disconnectAuditResult?.executorTag ?? null;

        embed.setTitle('🔇 Voice-Kanal verlassen')
          .setColor(0xe67e22)
          .addFields(
            { name: '👤 User', value: `<@${member.user.id}> (${member.user.tag})`, inline: true },
            { name: '🆔 User-ID', value: member.user.id, inline: true }
          );

        if (executorTag) {
          embed.addFields({ name: '✍️ Gekickt von', value: executorTag, inline: true });
        }

        embed.addFields({ name: '📢 Kanal', value: `<#${oldChannelId}>`, inline: false });
        await logChannel.send({ embeds: [embed] }).catch(() => null);
      } else if (oldChannelId && newChannelId) {
        // Switched channel
        const moveAuditResult = await resolveAuditExecutor(newState.guild, AuditLogEvent.MemberMove, member.user.id, {
          logContext: '[voice-log] Failed to fetch audit logs for move:',
        });
        const executorTag = moveAuditResult?.executorTag ?? null;

        embed.setTitle('🔀 Voice-Kanal gewechselt')
          .addFields(
            { name: '👤 User', value: `<@${member.user.id}> (${member.user.tag})`, inline: true },
            { name: '🆔 User-ID', value: member.user.id, inline: true }
          );

        if (executorTag) {
          embed.addFields({ name: '✍️ Verschoben von', value: executorTag, inline: true });
        }

        embed.addFields(
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
