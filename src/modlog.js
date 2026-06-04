const { EmbedBuilder } = require('discord.js');
const { formatDuration } = require('./duration');

const COLOR_WARN = 0xfaa61a;
const COLOR_TIMEOUT = 0xfaa61a;
const COLOR_KICK = 0xed4245;
const COLOR_BAN = 0xed4245;
const COLOR_AUTOMOD = 0xf59e0b;
const COLOR_REVERT = 0x57f287;

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

  if (action === 'unban') {
    return new EmbedBuilder()
      .setTitle('🔓 User entbannt')
      .setColor(COLOR_REVERT)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '👤 User', value: `<@${target.id}>`, inline: false },
        { name: '🛡️ Moderator', value: `<@${mod.id}>`, inline: false },
        { name: '📝 Grund', value: reasonValue, inline: false },
      )
      .setFooter({ text: footer })
      .setTimestamp();
  }

  if (action === 'untimeout') {
    return new EmbedBuilder()
      .setTitle('🔊 Timeout aufgehoben')
      .setColor(COLOR_REVERT)
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

const FILTER_LABELS = {
  spam:            'Spam',
  mention_spam:    'Mass-Mentions',
  invite_links:    'Invite-Link',
  keyword_preset:  'KeywordPreset',
  custom_wordlist: 'Custom-Wordlist',
};

function buildAutoModHitEmbed({
  caseNumber,
  filterKey,
  userId,
  username,
  channelId,
  content,
  matched,
  ruleId,
}) {
  const label = FILTER_LABELS[filterKey] ?? filterKey;
  const userLine    = username ? `<@${userId}> (${username})` : `<@${userId}>`;
  const channelLine = channelId ? `<#${channelId}>` : 'Unknown channel';

  return new EmbedBuilder()
    .setTitle(`🛡️ AutoMod Hit · Case #${caseNumber}`)
    .setColor(COLOR_AUTOMOD)
    .addFields(
      { name: 'User',     value: userLine,                   inline: false },
      { name: 'Filter',   value: label,                      inline: true  },
      { name: 'Channel',  value: channelLine,                inline: true  },
      { name: 'Trigger',  value: matched || '—',             inline: false },
      { name: 'Content',  value: content || '*(empty)*',     inline: false },
      { name: 'Rule-ID',  value: ruleId ? String(ruleId) : '—', inline: false },
    )
    .setFooter({ text: `Case #${caseNumber} · 🐾` })
    .setTimestamp();
}

module.exports = { buildModLogEmbed, buildAutoModHitEmbed };
