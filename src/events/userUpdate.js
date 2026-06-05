const { Events, EmbedBuilder } = require('discord.js');
const config = require('../config');

async function execute(oldUser, newUser) {
  const client = newUser.client;

  // Go through all cached guilds of the bot to check where the user is a member
  for (const guild of client.guilds.cache.values()) {
    try {
      const member = await guild.members.fetch(newUser.id).catch(() => null);
      if (!member) continue;

      const isProfileEnabled = await config.isLogProfileEnabled(guild.id);
      if (!isProfileEnabled) continue;

      const serverLogChannelId = await config.getServerLogChannelId(guild.id);
      if (!serverLogChannelId) continue;

      const logChannel = await guild.channels.fetch(serverLogChannelId).catch(() => null);
      if (!logChannel) continue;

      // 1. Username change
      if (oldUser.username !== newUser.username) {
        const embed = new EmbedBuilder()
          .setTitle('👤 Username geändert')
          .setColor(0x3498db)
          .addFields(
            { name: '👤 User', value: `<@${newUser.id}> (${newUser.tag})`, inline: true },
            { name: '🆔 User-ID', value: newUser.id, inline: true },
            { name: 'Vorher', value: oldUser.username, inline: true },
            { name: 'Nachher', value: newUser.username, inline: true }
          )
          .setTimestamp();
        await logChannel.send({ embeds: [embed] }).catch(() => null);
      }

      // 2. Avatar change
      if (oldUser.avatar !== newUser.avatar) {
        const embed = new EmbedBuilder()
          .setTitle('🖼️ Avatar geändert')
          .setColor(0x3498db)
          .setDescription(`<@${newUser.id}> (${newUser.tag}) hat das Profilbild geändert.`)
          .setThumbnail(newUser.displayAvatarURL({ size: 256 }))
          .addFields(
            { name: '🆔 User-ID', value: newUser.id, inline: true }
          )
          .setTimestamp();
        await logChannel.send({ embeds: [embed] }).catch(() => null);
      }
    } catch (err) {
      console.error(`[global-profile-log] userUpdate failed for guild ${guild.id}:`, err);
    }
  }
}

module.exports = {
  name: Events.UserUpdate,
  execute,
};
