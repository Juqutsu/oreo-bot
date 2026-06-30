const config = require('../config');

module.exports = {
  name: 'speech',

  async execute(msg) {
    if (!msg.content) return;

    const guild = msg.channel?.guild;
    if (!guild) return;

    const guildId = guild.id;

    try {
      // Load configurations
      const enabled = await config.getVoiceRecEnabled(guildId);
      if (!enabled) return;

      const channelId = await config.getVoiceRecChannelId(guildId);
      if (!channelId) return;

      // Robust check for "Oreo Ban" keyword (case-insensitive and tolerant of common speech-to-text variations)
      const cleanText = msg.content.toLowerCase().trim();
      const hasOreo = cleanText.includes('oreo');
      const hasBan = cleanText.includes('ban') || cleanText.includes('bann') || cleanText.includes('band');
      const isTriggered = (hasOreo && hasBan) || cleanText.includes('oreoban') || cleanText.includes('oreo-ban');

      if (isTriggered) {
        const targetChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (targetChannel) {
          const responseMessage = await config.getVoiceRecMessage(guildId);
          await targetChannel.send(responseMessage);
          console.log(`[voice-rec] Oreo Ban detected from ${msg.author?.tag} in voice channel ${msg.channel.name}. Sent response to text channel #${targetChannel.name}.`);
        }
      }
    } catch (err) {
      console.error('[voice-rec] Error in speech event handler:', err);
    }
  },
};
