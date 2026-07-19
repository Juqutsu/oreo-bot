const { Events, EmbedBuilder } = require('discord.js');
const config = require('../config');

async function execute(member) {
  const guildId = member.guild.id;

  try {
    const isJoinLeaveEnabled = await config.isLogJoinLeaveEnabled(guildId);
    if (isJoinLeaveEnabled) {
      const serverLogChannelId = await config.getServerLogChannelId(guildId);
      if (serverLogChannelId) {
        const logChannel = await member.guild.channels.fetch(serverLogChannelId).catch(() => null);
        if (logChannel) {
          const joinedAtSec = member.joinedAt ? Math.floor(member.joinedAt.getTime() / 1000) : null;
          const embed = new EmbedBuilder()
            .setTitle('📤 Member verlassen')
            .setColor(0xe74c3c)
            .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
            .addFields(
              { name: '👤 User', value: `<@${member.user.id}> (${member.user.tag})`, inline: true },
              { name: '🆔 User-ID', value: member.user.id, inline: true }
            )
            .setTimestamp();
          if (joinedAtSec) {
            embed.addFields({ name: '📅 Beigetreten am', value: `<t:${joinedAtSec}:F> (<t:${joinedAtSec}:R>)`, inline: false });
          }
          await logChannel.send({ embeds: [embed] }).catch(() => null);
        }
      }
    }
  } catch (err) {
    console.error('[leave-log] failed to log member leave:', err);
  }

  // Leave Card system
  try {
    const isLeaveOn = await config.isLeaveEnabled(guildId);
    if (isLeaveOn) {
      const leaveChannelId = await config.getLeaveChannelId(guildId);
      if (leaveChannelId) {
        const leaveChannel = await member.guild.channels.fetch(leaveChannelId).catch(() => null);
        if (leaveChannel) {
          const leaveMessageTemplate = await config.getLeaveMessage(guildId);
          const bgUrl = await config.getLeaveBgUrl(guildId);
          const bannerEnabled = await config.isLeaveBannerEnabled(guildId);

          // Compute the human (bot-excluded) member count once and share it between
          // the message text and the card, so the two can never disagree and neither
          // silently falls back to the bot-inclusive guild.memberCount.
          let memberCount = member.guild.memberCount;
          try {
            const members = await member.guild.members.fetch();
            memberCount = members.filter((m) => !m.user.bot).size;
          } catch (err) {
            console.warn('[leave-system] failed to fetch guild members, falling back to total memberCount:', err.message);
          }

          const { formatWelcomeMessage } = require('../welcomeCard');
          const messageText = await formatWelcomeMessage(leaveMessageTemplate, member, memberCount);

          const sendPayload = { content: messageText };

          if (bannerEnabled) {
            const { generateCard } = require('../welcomeCard');
            const cardBuffer = await generateCard(member.user, member.guild, 'leave', bgUrl, memberCount);
            const { AttachmentBuilder } = require('discord.js');
            const attachment = new AttachmentBuilder(cardBuffer, { name: 'leave.png' });
            sendPayload.files = [attachment];
          }

          await leaveChannel.send(sendPayload);
        }
      }
    }
  } catch (err) {
    console.error('[leave-system] failed to send leave card:', err);
  }
}

module.exports = {
  name: Events.GuildMemberRemove,
  execute,
};

