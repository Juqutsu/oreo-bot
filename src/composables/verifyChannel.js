const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ChannelType } = require('discord.js');
const config = require('../config');

// Ein Erstellungs-Promise pro Guild: verhindert, dass ein Raid mit N Joins
// N parallele Channel-Erstellungen auslöst (Rate-Limit-DoS via Channel-Create-Spam).
const creating = new Map();

/**
 * Löst den EINEN geteilten Verifizierungs-Kanal der Guild auf, oder legt ihn an,
 * falls er noch nicht existiert. Gleichzeitige Joins (Raid-Welle) teilen sich dasselbe
 * Erstellungs-Promise, sodass niemals mehr als ein Kanal pro Guild entsteht.
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<import('discord.js').TextChannel>}
 */
async function getOrCreateSharedVerifyChannel(guild) {
  const existingId = await config.getCaptchaChannelId(guild.id);
  if (existingId) {
    const existing = await guild.channels.fetch(existingId).catch(() => null);
    if (existing) return existing;
  }

  if (creating.has(guild.id)) return creating.get(guild.id);

  const promise = (async () => {
    const channel = await guild.channels.create({
      name: 'oreo-verify',
      type: ChannelType.GuildText,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          allow: ['ViewChannel', 'ReadMessageHistory'],
          deny: ['SendMessages', 'AddReactions', 'CreatePublicThreads', 'CreatePrivateThreads'],
        },
        {
          id: guild.client.user.id,
          allow: ['ViewChannel', 'SendMessages', 'ManageChannels', 'ManageRoles', 'ReadMessageHistory'],
        },
      ],
      reason: 'Oreo: Gemeinsamer Verifizierungs-Kanal',
    });

    const embed = new EmbedBuilder()
      .setTitle('🔐 Server-Verifizierung')
      .setColor(0x3498db)
      .setDescription('Willkommen! Um den Server freizuschalten, klicke auf den Button und löse das Captcha.')
      .setFooter({ text: '🐾 Oreo • Verifizierung' })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('captcha_global_start')
        .setLabel('Verifizierung starten')
        .setStyle(ButtonStyle.Primary),
    );

    await channel.send({ embeds: [embed], components: [row] });
    await config.setCaptchaChannelId(guild.id, channel.id);
    return channel;
  })().finally(() => creating.delete(guild.id));

  creating.set(guild.id, promise);
  return promise;
}

module.exports = { getOrCreateSharedVerifyChannel };
