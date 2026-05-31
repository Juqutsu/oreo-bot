const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const cases = require('../cases');

const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000; // 28 days — Discord API limit

/**
 * Parses a duration string like "30s", "10m", "2h", "1t", "1w".
 * Returns milliseconds or null if invalid.
 */
function parseDuration(str) {
  const match = str.trim().match(/^(\d+)\s*(s|m|h|t|w)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, t: 86_400_000, w: 604_800_000 };
  return value * multipliers[unit];
}

/**
 * Formats milliseconds into a human-readable German duration string.
 */
function formatDuration(ms) {
  const weeks = Math.floor(ms / 604_800_000);
  if (weeks > 0) return `${weeks} ${weeks === 1 ? 'Woche' : 'Wochen'}`;
  const days = Math.floor(ms / 86_400_000);
  if (days > 0) return `${days} ${days === 1 ? 'Tag' : 'Tage'}`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours > 0) return `${hours} ${hours === 1 ? 'Stunde' : 'Stunden'}`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes > 0) return `${minutes} ${minutes === 1 ? 'Minute' : 'Minuten'}`;
  const seconds = Math.floor(ms / 1000);
  return `${seconds} ${seconds === 1 ? 'Sekunde' : 'Sekunden'}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Gibt einem Mitglied einen Timeout.')
    .addUserOption(option =>
      option.setName('user').setDescription('Das Mitglied, das einen Timeout bekommen soll.').setRequired(true),
    )
    .addStringOption(option =>
      option
        .setName('duration')
        .setDescription('Dauer des Timeouts (z.B. 30s, 10m, 2h, 1t, 1w). Standard: 60m.')
        .setRequired(false),
    )
    .addStringOption(option =>
      option.setName('reason').setDescription('Grund für den Timeout.').setRequired(false),
    ),

  requiredTier: 'moderator',

  async execute(interaction) {
    const target = interaction.options.getUser('user');
    const durationInput = interaction.options.getString('duration') ?? '60m';
    const reason = interaction.options.getString('reason') ?? 'Kein Grund angegeben';
    const moderator = interaction.member;

    // Parse duration
    const durationMs = parseDuration(durationInput);
    if (!durationMs) {
      return interaction.reply({
        content: 'Ungültige Dauer. Nutze z.B. `30s`, `10m`, `2h`, `1t`, `1w`.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (durationMs > MAX_TIMEOUT_MS) {
      return interaction.reply({
        content: 'Die maximale Timeout-Dauer beträgt 28 Tage.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Self-timeout guard
    if (target.id === interaction.user.id) {
      return interaction.reply({
        content: 'Du kannst dir selbst keinen Timeout geben.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Bot-timeout guard
    if (target.id === interaction.client.user.id) {
      return interaction.reply({
        content: 'Ich kann mir selbst keinen Timeout geben.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const targetMember = interaction.guild.members.cache.get(target.id) ?? null;

    // Not-in-server guard
    if (!targetMember) {
      return interaction.reply({
        content: 'Dieses Mitglied ist nicht auf dem Server.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Owner guard
    if (target.id === interaction.guild.ownerId) {
      return interaction.reply({
        content: 'Der Server-Inhaber kann keinen Timeout bekommen.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Role hierarchy guard
    if (targetMember.roles.highest.position >= moderator.roles.highest.position) {
      return interaction.reply({
        content: 'Du kannst Mitglieder mit gleicher oder höherer Rolle nicht timeouten.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Bot moderatable guard
    if (!targetMember.moderatable) {
      return interaction.reply({
        content: 'Ich kann dieses Mitglied nicht timeouten (fehlende Berechtigungen).',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Execute timeout
    try {
      await targetMember.timeout(durationMs, `${moderator.user.tag}: ${reason}`);
    } catch (e) {
      console.error(e);
      return interaction.reply({
        content: 'Der Timeout hat nicht geklappt. Details stehen in den Logs.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const expiresAtDate = new Date(Date.now() + durationMs);
    let caseNumber;
    try {
      const result = await cases.createCase({
        guildId: interaction.guildId,
        userId: target.id,
        moderatorId: moderator.id,
        type: 'timeout',
        reason: interaction.options.getString('reason'),
        durationMs: BigInt(durationMs),
        expiresAt: expiresAtDate,
      });
      caseNumber = result.caseNumber;
    } catch (err) {
      console.error('createCase failed:', err);
      caseNumber = null;
    }

    const durationLabel = formatDuration(durationMs);
    const expiresAt = Math.floor((Date.now() + durationMs) / 1000);

    await interaction.reply({
      content: `**${target.username}** hat einen Timeout für **${durationLabel}** bekommen.`,
      flags: MessageFlags.Ephemeral,
    });

    try {
      const logChannel = await interaction.client.channels.fetch(process.env.MODLOG_CHANNEL_ID);
      const embed = new EmbedBuilder()
        .setColor(0xfaa61a)
        .setTitle('⏱️ Timeout vergeben')
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .addFields(
          { name: 'User', value: `${target} (${target.username})`, inline: true },
          { name: 'Moderator', value: `${moderator.user} (${moderator.user.username})`, inline: true },
          { name: 'Grund', value: reason },
          { name: 'Dauer', value: durationLabel, inline: true },
          { name: 'Läuft ab', value: `<t:${expiresAt}:f>`, inline: true },
        )
        .setFooter({ text: caseNumber ? `Case #${caseNumber} · 🐾` : 'Case-Eintrag fehlgeschlagen · 🐾' })
        .setTimestamp();
      await logChannel.send({ embeds: [embed] });
    } catch (err) {
      console.warn('ModLog send failed:', err);
      await interaction.followUp({
        content: 'Mod-Log-Eintrag fehlgeschlagen. Bitte `MODLOG_CHANNEL_ID` prüfen.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
