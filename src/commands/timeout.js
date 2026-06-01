const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const cases = require('../cases');
const config = require('../config');
const { parseDuration, formatDuration, MAX_TIMEOUT_MS } = require('../duration');
const { buildModLogEmbed } = require('../modlog');

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

    await interaction.reply({
      content: `**${target.username}** hat einen Timeout für **${durationLabel}** bekommen.`,
      flags: MessageFlags.Ephemeral,
    });

    try {
      const channelId = await config.getModLogChannelId(interaction.guildId);
      if (!channelId) {
        await interaction.followUp({
          content: 'Mod-Log nicht konfiguriert. Admin: `/config channel set type:modlog channel:<#x>` ausführen.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const logChannel = await interaction.client.channels.fetch(channelId);
      const embed = buildModLogEmbed({
        action: 'timeout',
        caseNumber,
        target,
        mod: moderator,
        reason,
        durationMs,
      });
      await logChannel.send({ embeds: [embed] });
    } catch (err) {
      console.warn('ModLog send failed:', err);
      await interaction.followUp({
        content: 'Mod-Log-Eintrag fehlgeschlagen — Channel-Permission oder Channel-ID prüfen.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
