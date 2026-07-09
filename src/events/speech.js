const config = require('../config');
const perms = require('../perms');
const voiceConfirm = require('../interactions/voiceconfirm');

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
      if (!enabled) {
        // Feature wurde deaktiviert, Bot hängt aber noch im VC → Verbindung
        // trennen, damit kein weiteres Audio zur Spracherkennung gestreamt wird.
        const { getVoiceConnection } = require('@discordjs/voice');
        getVoiceConnection(guildId)?.destroy();
        return;
      }

      const channelId = await config.getVoiceRecChannelId(guildId);
      if (!channelId) return;

      const cleanText = msg.content.toLowerCase().trim();

      // Wortbasiertes Matching: Befehl muss ein eigenes Wort DIREKT nach "oreo"
      // sein — "Oreo Banane" darf nicht mehr als "ban" zählen (frühere
      // Substring-Suche löste sonst bei ganz normaler Konversation aus).
      const words = cleanText.split(/[^a-zäöüß0-9-]+/).filter(Boolean);
      const oreoIdx = words.indexOf('oreo');
      if (oreoIdx === -1) return;
      const cmd = words[oreoIdx + 1] ?? '';
      const rest = words.slice(oreoIdx + 2);

      // Fetch member to check permission tiers (safely check guild.members for test mocking)
      const member = (guild.members && msg.author?.id)
        ? await guild.members.fetch(msg.author.id).catch(() => null)
        : null;

      const isStaff = member ? await perms.hasTier(guildId, member, 'supporter') : false;

      // 1. Meme-Reply: "Oreo ban", "Oreo bann", "Oreo band"
      if (['ban', 'bann', 'band', 'oreoban'].includes(cmd)) {
        const targetChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (targetChannel) {
          const responseMessage = await config.getVoiceRecMessage(guildId);
          await targetChannel.send(responseMessage);
          console.log(`[voice-rec] Oreo Ban detected from ${msg.author?.tag} in voice channel ${msg.channel.name}. Sent response to text channel #${targetChannel.name}.`);
        }
        return;
      }

      // 2. Support-Ruf: "Oreo hilf", "Oreo hilfe", "Oreo support", "Oreo supporter"
      if (['hilf', 'hilfe', 'support', 'supporter'].includes(cmd)) {
        const targetChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (targetChannel) {
          await targetChannel.send(`🚨 **Voice Support-Ruf:** <@${msg.author.id}> (${msg.author.tag}) benötigt Hilfe im Sprachkanal **${msg.channel.name}**!`);
          await msg.channel.send(`🐾 Oreo hat dich gehört, <@${msg.author.id}>. Ich habe das Team alarmiert!`);
        }
        return;
      }

      // 3. Lockdown — destruktiv → Button-Bestätigung. "Oreo lockdown", "Oreo ruhe"
      if (['lockdown', 'ruhe'].includes(cmd)) {
        if (!isStaff) {
          await msg.channel.send(`❌ <@${msg.author.id}>, dir fehlt das Supporter-Tier für diesen Befehl.`);
          return;
        }
        const targetChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (targetChannel) {
          await voiceConfirm.requestConfirmation({
            textChannel: targetChannel,
            voiceChannel: msg.channel,
            requester: msg.author,
            action: 'lockdown',
          });
        }
        return;
      }

      // 4. Unlock — restaurativ, bleibt direkt. "Oreo unlock", "Oreo aufheben"
      if (['unlock', 'aufheben'].includes(cmd)) {
        if (!isStaff) {
          await msg.channel.send(`❌ <@${msg.author.id}>, dir fehlt das Supporter-Tier für diesen Befehl.`);
          return;
        }

        // Reset speak override
        await msg.channel.permissionOverwrites.edit(guild.roles.everyone, { Speak: null }).catch(() => {});

        // Server-unmute everyone in VC
        for (const m of msg.channel.members.values()) {
          await m.voice.setMute(false, 'Oreo Sprach-Unlock').catch(() => {});
        }

        await msg.channel.send(`🔓 **Voice-Unlock:** Sprachkanal wurde durch <@${msg.author.id}> wieder freigegeben.`);
        return;
      }

      // 5. Voice-Mute — destruktiv → Button-Bestätigung. "Oreo mute [Name]", "Oreo stumm [Name]", "Oreo timeout [Name]"
      if (['mute', 'stumm', 'stummschalten', 'timeout'].includes(cmd)) {
        if (!isStaff) {
          await msg.channel.send(`❌ <@${msg.author.id}>, dir fehlt das Supporter-Tier für diesen Befehl.`);
          return;
        }

        const namePart = rest.join(' ').trim();
        if (namePart.length < 2) {
          await msg.channel.send(`❓ Bitte nenne einen Namen (z. B. "Oreo mute Lukas").`);
          return;
        }

        const vcMembers = [...msg.channel.members.values()];
        const targetMember = vcMembers.find((m) =>
          m.displayName.toLowerCase().includes(namePart) ||
          m.user.username.toLowerCase().includes(namePart)
        );

        if (!targetMember) {
          await msg.channel.send(`❓ Ich konnte kein Mitglied namens "${namePart}" im Sprachkanal finden.`);
          return;
        }

        const targetIsStaff = await perms.hasTier(guildId, targetMember, 'supporter');
        if (targetIsStaff) {
          await msg.channel.send(`❌ <@${msg.author.id}>, ich kann andere Teammitglieder nicht stummschalten!`);
          return;
        }

        const targetChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (targetChannel) {
          await voiceConfirm.requestConfirmation({
            textChannel: targetChannel,
            voiceChannel: msg.channel,
            requester: msg.author,
            action: 'mute',
            targetMember,
          });
        }
        return;
      }

    } catch (err) {
      console.error('[voice-rec] Error in speech event handler:', err);
    }
  },
};
