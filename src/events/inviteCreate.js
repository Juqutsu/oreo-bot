const { Events, EmbedBuilder } = require('discord.js');
const invitesTracker = require('../invites');
const config = require('../config');
const { formatDuration } = require('../duration');

async function execute(invite) {
  if (!invite.guild) return;
  const guildId = invite.guild.id;

  // 1. Keep caching behavior intact
  const cached = invitesTracker.inviteCache.get(guildId);
  if (cached) {
    cached.set(invite.code, invite.uses ?? 0);
  }

  // 2. Perform Logging
  try {
    const isInviteEnabled = await config.isLogInviteEnabled(guildId);
    if (!isInviteEnabled) return;

    const serverLogChannelId = await config.getServerLogChannelId(guildId);
    if (!serverLogChannelId) return;

    const logChannel = await invite.guild.channels.fetch(serverLogChannelId).catch(() => null);
    if (!logChannel) return;

    const inviterVal = invite.inviter ? `<@${invite.inviter.id}> (${invite.inviter.tag})` : 'Unbekannt';
    const channelVal = invite.channel ? `<#${invite.channel.id}> (#${invite.channel.name})` : 'Unbekannt';
    const maxUsesVal = invite.maxUses === 0 ? 'Unbegrenzt' : `${invite.maxUses}`;
    const maxAgeVal = invite.maxAge === 0 ? 'Niemals' : formatDuration(invite.maxAge * 1000);
    const tempVal = invite.temporary ? 'Ja' : 'Nein';

    const embed = new EmbedBuilder()
      .setTitle('🎫 Einladung erstellt')
      .setColor(0x2ecc71)
      .addFields(
        { name: '🔗 Code', value: `\`${invite.code}\``, inline: true },
        { name: '👤 Erstellt von', value: inviterVal, inline: true },
        { name: '📺 Channel', value: channelVal, inline: true },
        { name: '🔢 Max. Nutzungen', value: maxUsesVal, inline: true },
        { name: '⏱️ Gültigkeit', value: maxAgeVal, inline: true },
        { name: '⏳ Temporär', value: tempVal, inline: true }
      )
      .setTimestamp()
      .setFooter({ text: '🐾 Oreo' });

    await logChannel.send({ embeds: [embed] }).catch(() => null);
  } catch (err) {
    console.error('[invite-log] failed to log invite creation:', err);
  }
}

module.exports = {
  name: Events.InviteCreate,
  execute,
};
