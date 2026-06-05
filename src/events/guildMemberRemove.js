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
}

module.exports = {
  name: Events.GuildMemberRemove,
  execute,
};
