const { EmbedBuilder } = require('discord.js');
const { formatDuration } = require('./duration');

const COLOR_WARN = 0xfaa61a;
const COLOR_TIMEOUT = 0xfaa61a;
const COLOR_KICK = 0xed4245;
const COLOR_BAN = 0xed4245;

function buildModLogEmbed({
  action,
  caseNumber,
  target,
  mod,
  reason,
  durationMs,
  dmFailed = false,
}) {
  const footer = caseNumber
    ? `Case #${caseNumber} · 🐾`
    : 'Case-Eintrag fehlgeschlagen · 🐾';
  const reasonValue = reason ?? 'Kein Grund angegeben';

  if (action === 'warn') {
    const embed = new EmbedBuilder()
      .setTitle('⚠️ User verwarnt')
      .setColor(COLOR_WARN)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '👤 User', value: `<@${target.id}>`, inline: false },
        { name: '🛡️ Moderator', value: `<@${mod.id}>`, inline: false },
        { name: '📝 Grund', value: reasonValue, inline: false },
      );
    if (dmFailed) {
      embed.addFields({ name: '📬 DM', value: 'Nicht zugestellt (DMs aus?)', inline: false });
    }
    return embed.setFooter({ text: footer }).setTimestamp();
  }

  if (action === 'timeout') {
    const expSec = Math.floor((Date.now() + durationMs) / 1000);
    return new EmbedBuilder()
      .setTitle('⏱️ Timeout vergeben')
      .setColor(COLOR_TIMEOUT)
      .setThumbnail(target.displayAvatarURL({ dynamic: true }))
      .addFields(
        { name: 'User', value: `<@${target.id}>`, inline: true },
        { name: 'Moderator', value: `<@${mod.id}>`, inline: true },
        { name: 'Grund', value: reasonValue, inline: false },
        { name: 'Dauer', value: formatDuration(durationMs), inline: true },
        { name: 'Läuft ab', value: `<t:${expSec}:f>`, inline: true },
      )
      .setFooter({ text: footer })
      .setTimestamp();
  }

  if (action === 'kick') {
    return new EmbedBuilder()
      .setTitle('User gekickt')
      .setColor(COLOR_KICK)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '👤 User', value: `<@${target.id}>`, inline: false },
        { name: '🛡️ Moderator', value: `<@${mod.id}>`, inline: false },
        { name: '📝 Grund', value: reasonValue, inline: false },
      )
      .setFooter({ text: footer })
      .setTimestamp();
  }

  if (action === 'ban') {
    return new EmbedBuilder()
      .setTitle('🔨 User gebannt')
      .setColor(COLOR_BAN)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '👤 User', value: `<@${target.id}>`, inline: false },
        { name: '🛡️ Moderator', value: `<@${mod.id}>`, inline: false },
        { name: '📝 Grund', value: reasonValue, inline: false },
      )
      .setFooter({ text: footer })
      .setTimestamp();
  }

  return null;
}

module.exports = { buildModLogEmbed };
