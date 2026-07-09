const config = require('../config');
const perms = require('../perms');

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
      const hasOreo = cleanText.includes('oreo');
      if (!hasOreo) return;

      // Fetch member to check permission tiers (safely check guild.members for test mocking)
      const member = (guild.members && msg.author?.id)
        ? await guild.members.fetch(msg.author.id).catch(() => null)
        : null;

      const isStaff = member ? await perms.hasTier(guildId, member, 'supporter') : false;

      // 1. Original Oreo Ban
      const hasBan = cleanText.includes('ban') || cleanText.includes('bann') || cleanText.includes('band');
      const isOreoBan = hasBan || cleanText.includes('oreoban') || cleanText.includes('oreo-ban');

      if (isOreoBan) {
        const targetChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (targetChannel) {
          const responseMessage = await config.getVoiceRecMessage(guildId);
          await targetChannel.send(responseMessage);
          console.log(`[voice-rec] Oreo Ban detected from ${msg.author?.tag} in voice channel ${msg.channel.name}. Sent response to text channel #${targetChannel.name}.`);
        }
        return;
      }

      // 2. Voice support call: "Oreo hilf mir", "Oreo support", "Oreo hilfe"
      const isSupportCall = cleanText.includes('hilf') || cleanText.includes('hilfe') || cleanText.includes('support') || cleanText.includes('supporter');
      if (isSupportCall) {
        const targetChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (targetChannel) {
          await targetChannel.send(`🚨 **Voice Support-Ruf:** <@${msg.author.id}> (${msg.author.tag}) benötigt Hilfe im Sprachkanal **${msg.channel.name}**!`);
          await msg.channel.send(`🐾 Oreo hat dich gehört, <@${msg.author.id}>. Ich habe das Team alarmiert!`);
        }
        return;
      }

      // 3. Voice lockdown: "Oreo ruhe", "Oreo lockdown", "Oreo leise", "Oreo stop"
      const isLockdownCall = cleanText.includes('ruhe') || cleanText.includes('lockdown') || cleanText.includes('leise') || cleanText.includes('stop');
      if (isLockdownCall) {
        if (!isStaff) {
          await msg.channel.send(`❌ <@${msg.author.id}>, dir fehlt das Supporter-Tier für diesen Befehl.`);
          return;
        }

        // Lock channel speaking rights
        await msg.channel.permissionOverwrites.edit(guild.roles.everyone, { Speak: false }).catch(() => {});
        
        // Server-mute non-staff members in VC
        let mutedCount = 0;
        for (const m of msg.channel.members.values()) {
          if (m.user.bot) continue;
          const isTargetStaff = await perms.hasTier(guildId, m, 'supporter');
          if (!isTargetStaff) {
            await m.voice.setMute(true, 'Oreo Sprach-Lockdown').catch(() => {});
            mutedCount++;
          }
        }

        await msg.channel.send(`🔒 **Voice-Lockdown:** Sprachkanal wurde durch <@${msg.author.id}> gesperrt. ${mutedCount} User stummgeschaltet.`);
        return;
      }

      // 4. Voice unlock: "Oreo aufheben", "Oreo unlock", "Oreo sprechen", "Oreo laut"
      const isUnlockCall = cleanText.includes('aufheben') || cleanText.includes('unlock') || cleanText.includes('sprechen') || cleanText.includes('laut');
      if (isUnlockCall) {
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

      // 5. Voice mute: "Oreo mute [name]", "Oreo stumm [name]", "Oreo timeout [name]"
      const isMuteCall = cleanText.includes('mute') || cleanText.includes('stumm') || cleanText.includes('timeout') || cleanText.includes('stummschalten');
      if (isMuteCall) {
        if (!isStaff) {
          await msg.channel.send(`❌ <@${msg.author.id}>, dir fehlt das Supporter-Tier für diesen Befehl.`);
          return;
        }

        // Clean name parameter
        let namePart = cleanText
          .replace('oreo', '')
          .replace('stummschalten', '')
          .replace('stumm', '')
          .replace('timeout', '')
          .replace('mute', '')
          .trim();

        if (namePart.length < 2) {
          await msg.channel.send(`❓ Bitte nenne einen Namen (z. B. "Oreo mute Lukas").`);
          return;
        }

        const vcMembers = [...msg.channel.members.values()];
        const targetMember = vcMembers.find(m => 
          m.displayName.toLowerCase().includes(namePart) || 
          m.user.username.toLowerCase().includes(namePart)
        );

        if (targetMember) {
          const targetIsStaff = await perms.hasTier(guildId, targetMember, 'supporter');
          if (targetIsStaff) {
            await msg.channel.send(`❌ <@${msg.author.id}>, ich kann andere Teammitglieder nicht stummschalten!`);
          } else {
            // Timeout target for 5 minutes
            await targetMember.timeout(5 * 60 * 1000, `Sprach-Mute durch ${msg.author.tag}`).catch(() => {});
            // Also server-mute in voice channel
            await targetMember.voice.setMute(true, `Sprach-Mute durch ${msg.author.tag}`).catch(() => {});
            await msg.channel.send(`🔇 **Sprach-Mute:** <@${targetMember.id}> wurde für 5 Minuten stummgeschaltet.`);
          }
        } else {
          await msg.channel.send(`❓ Ich konnte kein Mitglied namens "${namePart}" im Sprachkanal finden.`);
        }
        return;
      }

    } catch (err) {
      console.error('[voice-rec] Error in speech event handler:', err);
    }
  },
};
