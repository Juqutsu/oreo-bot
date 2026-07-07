const { Events, EmbedBuilder, AuditLogEvent } = require('discord.js');
const config = require('../config');
const { resolveAuditExecutor } = require('../auditExecutor');

const VERIFICATION_LEVEL_LABELS = {
  0: 'Keine',
  1: 'Niedrig (Verifizierte E-Mail)',
  2: 'Mittel (Registriert seit > 5 Min)',
  3: 'Hoch (Mitglied auf Server seit > 10 Min)',
  4: 'Sehr hoch (Verifizierte Telefonnummer)',
};

async function execute(oldGuild, newGuild) {
  const guildId = newGuild.id;

  try {
    const serverLogChannelId = await config.getServerLogChannelId(guildId);
    if (!serverLogChannelId) return;

    const logChannel = await newGuild.channels.fetch(serverLogChannelId).catch(() => null);
    if (!logChannel) return;

    const nameChanged = oldGuild.name !== newGuild.name;
    const iconChanged = oldGuild.icon !== newGuild.icon;
    const ownerChanged = oldGuild.ownerId !== newGuild.ownerId;
    const verificationChanged = oldGuild.verificationLevel !== newGuild.verificationLevel;
    const systemChannelChanged = oldGuild.systemChannelId !== newGuild.systemChannelId;

    if (!nameChanged && !iconChanged && !ownerChanged && !verificationChanged && !systemChannelChanged) return;

    // GuildUpdate audit-log entries always target the guild itself (targetId === guild.id),
    // so matching on newGuild.id is equivalent to the previous entries.first() lookup.
    const auditResult = await resolveAuditExecutor(newGuild, AuditLogEvent.GuildUpdate, newGuild.id, {
      logContext: '[guild-log] Failed to fetch audit logs for guild update:',
    });
    const executorTag = auditResult?.executorTag ?? null;

    const embed = new EmbedBuilder()
      .setTitle('🌐 Servereinstellungen geändert')
      .setColor(0x3498db)
      .setTimestamp()
      .setFooter({ text: '🐾 Oreo' });

    if (executorTag) {
      embed.addFields({ name: '✍️ Geändert von', value: executorTag, inline: false });
    }

    if (nameChanged) {
      embed.addFields(
        { name: '📝 Servername (vorher)', value: oldGuild.name, inline: true },
        { name: '📝 Servername (nachher)', value: newGuild.name, inline: true },
        { name: '\u200b', value: '\u200b', inline: true }
      );
    }

    if (iconChanged) {
      embed.addFields({ name: '🖼️ Server-Icon', value: 'Das Server-Icon wurde aktualisiert.', inline: false });
      if (newGuild.iconURL()) {
        embed.setThumbnail(newGuild.iconURL({ size: 256 }));
      }
    }

    if (ownerChanged) {
      embed.addFields(
        { name: '👑 Besitzer (vorher)', value: `<@${oldGuild.ownerId}> (ID: ${oldGuild.ownerId})`, inline: true },
        { name: '👑 Besitzer (nachher)', value: `<@${newGuild.ownerId}> (ID: ${newGuild.ownerId})`, inline: true },
        { name: '\u200b', value: '\u200b', inline: true }
      );
    }

    if (verificationChanged) {
      const oldLevel = VERIFICATION_LEVEL_LABELS[oldGuild.verificationLevel] ?? `Stufe ${oldGuild.verificationLevel}`;
      const newLevel = VERIFICATION_LEVEL_LABELS[newGuild.verificationLevel] ?? `Stufe ${newGuild.verificationLevel}`;
      embed.addFields(
        { name: '🔒 Verifizierungsstufe (vorher)', value: oldLevel, inline: true },
        { name: '🔒 Verifizierungsstufe (nachher)', value: newLevel, inline: true },
        { name: '\u200b', value: '\u200b', inline: true }
      );
    }

    if (systemChannelChanged) {
      const oldChan = oldGuild.systemChannelId ? `<#${oldGuild.systemChannelId}>` : 'Keiner';
      const newChan = newGuild.systemChannelId ? `<#${newGuild.systemChannelId}>` : 'Keiner';
      embed.addFields(
        { name: '📢 System-Channel (vorher)', value: oldChan, inline: true },
        { name: '📢 System-Channel (nachher)', value: newChan, inline: true },
        { name: '\u200b', value: '\u200b', inline: true }
      );
    }

    await logChannel.send({ embeds: [embed] }).catch(() => null);
  } catch (err) {
    console.error('[guild-log] guildUpdate failed:', err);
  }
}

module.exports = {
  name: Events.GuildUpdate,
  execute,
};
