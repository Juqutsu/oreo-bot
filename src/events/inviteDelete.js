const { Events, EmbedBuilder } = require('discord.js');
const invitesTracker = require('../invites');
const config = require('../config');

async function execute(invite) {
  if (!invite.guild) return;
  const guildId = invite.guild.id;

  // 1. Keep caching behavior intact
  const cached = invitesTracker.inviteCache.get(guildId);
  if (cached) {
    cached.delete(invite.code);
  }

  // 2. Perform Logging
  try {
    const isInviteEnabled = await config.isLogInviteEnabled(guildId);
    if (!isInviteEnabled) return;

    const serverLogChannelId = await config.getServerLogChannelId(guildId);
    if (!serverLogChannelId) return;

    const logChannel = await invite.guild.channels.fetch(serverLogChannelId).catch(() => null);
    if (!logChannel) return;

    const channelVal = invite.channelId ? `<#${invite.channelId}>` : (invite.channel ? `<#${invite.channel.id}>` : 'Unbekannt');

    const embed = new EmbedBuilder()
      .setTitle('🗑️ Einladung gelöscht')
      .setColor(0xe74c3c)
      .addFields(
        { name: '🔗 Code', value: `\`${invite.code}\``, inline: true },
        { name: '📺 Channel', value: channelVal, inline: true }
      )
      .setTimestamp()
      .setFooter({ text: '🐾 Oreo' });

    await logChannel.send({ embeds: [embed] }).catch(() => null);
  } catch (err) {
    console.error('[invite-log] failed to log invite deletion:', err);
  }
}

module.exports = {
  name: Events.InviteDelete,
  execute,
};
