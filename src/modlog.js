const { EmbedBuilder, MessageFlags } = require('discord.js');
const { formatDuration } = require('./duration');
const config = require('./config');

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
    const embed = new EmbedBuilder()
      .setTitle('🔨 User gebannt')
      .setColor(COLOR_BAN)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '👤 User', value: `<@${target.id}>`, inline: false },
        { name: '🛡️ Moderator', value: `<@${mod.id}>`, inline: false },
        { name: '📝 Grund', value: reasonValue, inline: false },
      );
    if (durationMs) {
      const expSec = Math.floor((Date.now() + durationMs) / 1000);
      embed.addFields(
        { name: '⏱️ Dauer', value: formatDuration(durationMs), inline: true },
        { name: '📅 Läuft ab', value: `<t:${expSec}:f>`, inline: true }
      );
    }
    return embed.setFooter({ text: footer }).setTimestamp();
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

  if (action === 'mute') {
    const embed = new EmbedBuilder()
      .setTitle('🔇 User stummgeschaltet')
      .setColor(0x9b59b6)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '👤 User', value: `<@${target.id}>`, inline: false },
        { name: '🛡️ Moderator', value: `<@${mod.id}>`, inline: false },
        { name: '📝 Grund', value: reasonValue, inline: false },
      );
    if (durationMs) {
      const expSec = Math.floor((Date.now() + durationMs) / 1000);
      embed.addFields(
        { name: '⏱️ Dauer', value: formatDuration(durationMs), inline: true },
        { name: '📅 Läuft ab', value: `<t:${expSec}:f>`, inline: true }
      );
    }
    return embed.setFooter({ text: footer }).setTimestamp();
  }

  if (action === 'unmute') {
    return new EmbedBuilder()
      .setTitle('🔊 Stummschaltung aufgehoben')
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

  if (action === 'softban') {
    return new EmbedBuilder()
      .setTitle('ℹ️ User soft-gebannt')
      .setColor(0xe67e22)
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

/**
 * Sends a mod-log embed for a slash-command interaction (best-effort).
 *
 * Encapsulates the tail every moderation command used to copy-paste:
 * getModLogChannelId → warn (ephemeral followUp) if unset → channels.fetch →
 * buildModLogEmbed → send → warn (ephemeral followUp) on failure.
 *
 * `embedParams` is forwarded to buildModLogEmbed. Commands with bespoke
 * embeds (e.g. /removewarn, /reason) can pass a prebuilt EmbedBuilder via
 * `embedParams.embed` instead.
 *
 * Never throws; failures are logged and reported to the moderator only.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {object} embedParams
 */
async function sendModLog(interaction, embedParams) {
  try {
    const channelId = await config.getModLogChannelId(interaction.guildId);
    if (!channelId) {
      await interaction.followUp({
        content: '⚠️ Mod-Log-Channel ist nicht konfiguriert (/setup) — die Aktion wurde NICHT geloggt.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => null);
      return;
    }
    const logChannel = await interaction.client.channels.fetch(channelId);
    const embed = embedParams.embed ?? buildModLogEmbed(embedParams);
    await logChannel.send({ embeds: [embed] });
  } catch (e) {
    console.warn('ModLog send failed:', e);
    await interaction.followUp({
      content: '⚠️ Mod-Log-Eintrag fehlgeschlagen — prüfe die Channel-Berechtigungen.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => null);
  }
}

module.exports = { buildModLogEmbed, buildAutoModHitEmbed, sendModLog };
