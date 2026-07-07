const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const cases = require('../cases');
const { parseDuration, formatDuration, MAX_TIMEOUT_MS } = require('../duration');
const { sendModLog } = require('../modlog');
const { validateModTarget } = require('../modGuards');

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
      option.setName('reason').setDescription('Grund für den Timeout.').setMaxLength(512).setRequired(false),
    ),

  requiredTier: 'supporter',

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

    // Standard guards (member required, self/bot/owner/hierarchy/moderatable).
    const guard = await validateModTarget(interaction, target, { action: 'timeout' });
    if (!guard.ok) {
      return interaction.reply({ content: guard.message, flags: MessageFlags.Ephemeral });
    }
    const targetMember = guard.targetMember;

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

    let caseNumber;
    try {
      const result = await cases.createCase({
        guildId: interaction.guildId,
        userId: target.id,
        moderatorId: moderator.id,
        type: 'timeout',
        reason: interaction.options.getString('reason'),
        durationMs: BigInt(durationMs),
        expiresInMs: durationMs,
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

    await sendModLog(interaction, {
      action: 'timeout',
      caseNumber,
      target,
      mod: moderator,
      reason,
      durationMs,
    });
  },
};
