const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const cases = require('../cases');
const { sendModLog } = require('../modlog');
const { validateModTarget } = require('../modGuards');
const { parseDuration, MAX_TEMP_MS } = require('../duration');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Bannt einen Nutzer vom Server.')
    .addUserOption((option) => option.setName('target').setDescription('Wer soll gebannt werden?').setRequired(true))
    .addStringOption((option) => option.setName('duration').setDescription('Optional: Dauer des Bans (z.B. 30m, 2h, 7d)').setRequired(false))
    .addStringOption((reason) => reason.setName('reason').setDescription('Grund für den Ban').setMaxLength(512).setRequired(false))
    .addStringOption((option) =>
      option.setName('delete_messages')
        .setDescription('Optional: Verlauf der gelöschten Nachrichten des Nutzers')
        .setRequired(false)
        .addChoices(
          { name: 'Keine', value: '0' },
          { name: 'Letzte Stunde', value: '3600' },
          { name: 'Letzten 24 Stunden', value: '86400' },
          { name: 'Letzten 7 Tage', value: '604800' }
        )
    ),

  requiredTier: 'moderator',

  async execute(interaction) {
    const target = interaction.options.getUser('target');
    const durationInput = interaction.options.getString('duration');
    const reason = interaction.options.getString('reason') ?? 'Kein Grund angegeben';
    const deleteMessagesInput = interaction.options.getString('delete_messages');

    let durationMs = null;

    if (durationInput) {
      durationMs = parseDuration(durationInput);
      if (!durationMs) {
        return interaction.reply({
          content: '❌ Ungültige Dauer. Nutze z.B. `30s`, `10m`, `2h`, `7d`.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (durationMs > MAX_TEMP_MS) {
        return interaction.reply({
          content: '❌ Die maximale Temp-Ban-Dauer beträgt 365 Tage. Für länger nutze einen permanenten Ban.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    const moderator = interaction.member;

    // Standard guards (self/bot/owner/hierarchy/bannable) — ban works on non-members too.
    const guard = await validateModTarget(interaction, target, { action: 'ban', requireMember: false });
    if (!guard.ok) {
      return interaction.reply({ content: guard.message, flags: MessageFlags.Ephemeral });
    }

    const deleteMessageSeconds = deleteMessagesInput ? parseInt(deleteMessagesInput, 10) : 0;

    try {
      await interaction.guild.members.ban(target.id, {
        reason: `${moderator.user.tag}: ${reason}`,
        deleteMessageSeconds,
      });
    } catch (e) {
      console.error(e);
      return interaction.reply({
        content: 'Der Ban hat nicht geklappt. Details stehen in den Logs.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Alte aktive Ban-Rows deaktivieren, damit ein späterer permanenter Re-Ban nicht durch eine
    // abgelaufene Temp-Ban-Row automatisch entbannt wird (background.js entbannt bei JEDER aktiven Zeile).
    await cases.deactivateActiveInfractions(interaction.guildId, target.id, 'ban').catch(err => console.error('[ban] Deactivating old ban rows failed:', err));

    let caseNumber;
    try {
      const result = await cases.createCase({
        guildId: interaction.guildId,
        userId: target.id,
        moderatorId: moderator.id,
        type: 'ban',
        reason: interaction.options.getString('reason'),
        durationMs: durationMs ? BigInt(durationMs) : null,
        expiresInMs: durationMs || null,
      });
      caseNumber = result.caseNumber;
    } catch (err) {
      console.error('createCase failed:', err);
      caseNumber = null;
      if (durationMs) {
        // Ohne Case-Row kann der Background-Loop nie entbannen → Temp-Ban zurücknehmen.
        await interaction.guild.members.unban(target.id, 'Oreo: Temp-Ban zurückgenommen (Datenbankfehler)').catch(() => null);
        return interaction.reply({
          content: '❌ Datenbankfehler — der Temp-Ban wurde **zurückgenommen**, damit er nicht versehentlich permanent wird. Versuch es später erneut.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    const banMessage = durationMs 
      ? `**${target.username}** wurde temporär gebannt. (Case #${caseNumber ?? 'nicht gespeichert'})`
      : `**${target.username}** wurde permanent gebannt. (Case #${caseNumber ?? 'nicht gespeichert'})`;

    await interaction.reply({
      content: banMessage,
      flags: MessageFlags.Ephemeral,
    });

    await sendModLog(interaction, {
      action: 'ban',
      caseNumber,
      target,
      mod: moderator,
      reason,
      durationMs,
    });
  },
};