const { Events, EmbedBuilder } = require('discord.js');
const config = require('../config');
const { formatDuration } = require('../duration');

async function execute(member) {
  // Ignore bots
  if (member.user.bot) return;

  const guildId = member.guild.id;

  try {
    const minDays = await config.getMinAccountAgeDays(guildId);
    if (minDays <= 0) return; // Feature disabled

    const ageMs = Date.now() - member.user.createdAt.getTime();
    const limitMs = minDays * 24 * 60 * 60 * 1000;

    if (ageMs < limitMs) {
      const channelId = await config.getModLogChannelId(guildId);
      if (!channelId) {
        console.warn(`[account-age-check] warning: Account age check triggered for ${member.user.tag} but modlog is not configured.`);
        return;
      }

      const logChannel = await member.guild.channels.fetch(channelId).catch(() => null);
      if (!logChannel) return;

      const createdSec = Math.floor(member.user.createdAt.getTime() / 1000);
      const embed = new EmbedBuilder()
        .setTitle('🚨 Verdächtiger Account-Beitritt')
        .setColor(0xe67e22) // orange
        .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: '👤 User', value: `<@${member.user.id}> (${member.user.tag})`, inline: false },
          { name: '📅 Registriert vor', value: formatDuration(ageMs), inline: true },
          { name: '⏳ Registrierungsdatum', value: `<t:${createdSec}:F> (<t:${createdSec}:R>)`, inline: false }
        )
        .setFooter({ text: '🐾 Oreo • Kontoalters-Warnung' })
        .setTimestamp();

      await logChannel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error('[account-age-check] failed to check account age:', err);
  }
}

module.exports = {
  name: Events.GuildMemberAdd,
  execute,
};
