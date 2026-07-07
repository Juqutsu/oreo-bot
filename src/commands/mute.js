const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const cases = require('../cases');
const config = require('../config');
const { buildModLogEmbed } = require('../modlog');
const { parseDuration, MAX_TEMP_MS } = require('../duration');
const { getOrCreateMutedRole } = require('../composables/mutedRole');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Stummschaltet einen Nutzer serverweit (über Mute-Rolle).')
    .addUserOption((o) => o.setName('target').setDescription('Wer soll stummgeschaltet werden?').setRequired(true))
    .addStringOption((o) => o.setName('duration').setDescription('Optional: Dauer (z.B. 30m, 2h, 7d, 90d)').setRequired(false))
    .addStringOption((o) => o.setName('reason').setDescription('Grund für die Stummschaltung').setMaxLength(512).setRequired(false)),

  requiredTier: 'moderator',

  async execute(interaction) {
    const target = interaction.options.getUser('target');
    const durationInput = interaction.options.getString('duration');
    const reason = interaction.options.getString('reason') ?? 'Kein Grund angegeben';
    const moderator = interaction.member;
    const botMember = interaction.guild.members.me;

    const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (!targetMember) {
      return interaction.reply({
        content: 'Dieser User ist nicht (mehr) auf dem Server.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (target.id === moderator.id) {
      return interaction.reply({
        content: 'Selbst-Mute geht nicht.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (target.id === botMember.id) {
      return interaction.reply({
        content: 'Oreo kann sich nicht selber stummschalten.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (target.id === interaction.guild.ownerId) {
      return interaction.reply({
        content: 'Den Server-Inhaber kannst du nicht stummschalten.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (moderator.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) {
      return interaction.reply({
        content: 'Diese Person hat dieselbe oder eine höhere Rolle als du.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Resolve Muted role
    const role = await getOrCreateMutedRole(interaction.guild);
    if (!role) {
      return interaction.reply({
        content: '❌ Die `Muted`-Rolle konnte weder gefunden noch erstellt werden. Bitte prüfe meine Permissions.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Role hierarchy check for bot
    if (botMember.roles.highest.comparePositionTo(role) <= 0) {
      return interaction.reply({
        content: '❌ Die `Muted`-Rolle liegt über meiner höchsten Rolle. Ich kann sie nicht zuweisen.',
        flags: MessageFlags.Ephemeral,
      });
    }

    let durationMs = null;
    if (durationInput) {
      durationMs = parseDuration(durationInput);
      if (!durationMs) {
        return interaction.reply({
          content: '❌ Ungültige Dauer. Nutze z.B. `30s`, `10m`, `2h`, `7d`, `90d`.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (durationMs > MAX_TEMP_MS) {
        return interaction.reply({
          content: '❌ Die maximale Temp-Mute-Dauer beträgt 365 Tage.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    try {
      await targetMember.roles.add(role, `${moderator.user.tag}: ${reason}`);
    } catch (e) {
      console.error(e);
      return interaction.reply({
        content: 'Das Zuweisen der Mute-Rolle hat nicht geklappt.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Deactivate previous active mutes for this user
    try {
      await cases.deactivateActiveInfractions(interaction.guildId, target.id, 'mute');
    } catch (err) {
      console.warn('deactivateActiveInfractions failed:', err);
    }

    let caseNumber;
    try {
      const result = await cases.createCase({
        guildId: interaction.guildId,
        userId: target.id,
        moderatorId: moderator.id,
        type: 'mute',
        reason: interaction.options.getString('reason'),
        durationMs: durationMs ? BigInt(durationMs) : null,
        expiresInMs: durationMs || null,
      });
      caseNumber = result.caseNumber;
    } catch (err) {
      console.error('createCase failed:', err);
      caseNumber = null;
      if (durationMs) {
        await targetMember.roles.remove(role, 'Oreo: Temp-Mute zurückgenommen (Datenbankfehler)').catch(() => null);
        return interaction.reply({
          content: '❌ Datenbankfehler — der Temp-Mute wurde **zurückgenommen**, damit er nicht versehentlich permanent wird. Versuch es später erneut.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    const muteMsg = durationMs
      ? `**${target.username}** wurde stummgeschaltet. (Dauer: ${durationInput}, Case #${caseNumber ?? 'nicht gespeichert'})`
      : `**${target.username}** wurde permanent stummgeschaltet. (Case #${caseNumber ?? 'nicht gespeichert'})`;

    await interaction.reply({
      content: muteMsg,
      flags: MessageFlags.Ephemeral,
    });

    try {
      const channelId = await config.getModLogChannelId(interaction.guildId);
      if (channelId) {
        const logChannel = await interaction.client.channels.fetch(channelId);
        const modEmbed = buildModLogEmbed({
          action: 'mute',
          caseNumber,
          target,
          mod: moderator,
          reason,
          durationMs,
        });
        await logChannel.send({ embeds: [modEmbed] });
      }
    } catch (e) {
      console.warn('ModLog send failed:', e);
    }
  },
};
