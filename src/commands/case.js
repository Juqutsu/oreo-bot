const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const cases = require('../cases');
const reports = require('../reports');

const TYPE_LABELS = {
  warn: '⚠️ Verwarnung',
  timeout: '🔇 Timeout',
  untimeout: '🔊 Timeout aufgehoben',
  kick: '👢 Kick',
  ban: '🔨 Ban',
  unban: '🔓 Unban',
  warn_removed: '✅ Verwarnung entfernt',
  reason_edited: '📝 Grund editiert',
  automod_hit: '🛡️ AutoMod Hit',
};

const TYPE_COLORS = {
  warn: 0xfaa61a,
  timeout: 0xfaa61a,
  untimeout: 0x57f287,
  kick: 0xed4245,
  ban: 0xed4245,
  unban: 0x57f287,
  warn_removed: 0x57f287,
  reason_edited: 0x5865f2,
  automod_hit: 0xf59e0b,
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('case')
    .setDescription('Zeigt einen Case anhand der Nummer.')
    .addIntegerOption((option) => option.setName('number').setDescription('Case-Nummer').setRequired(true).setMinValue(1)),

  requiredTier: 'supporter',

  async execute(interaction) {
    const caseNumber = interaction.options.getInteger('number');

    let c;
    try {
      c = await cases.getCaseByNumber(interaction.guildId, caseNumber);
    } catch (err) {
      console.error('getCaseByNumber failed:', err);
      return interaction.reply({
        content: 'Datenbankfehler — versuch es später nochmal.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!c) {
      return interaction.reply({
        content: `Case #${caseNumber} nicht gefunden.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const label = TYPE_LABELS[c.type] ?? c.type;
    const color = TYPE_COLORS[c.type] ?? 0x99aab5;
    const createdSec = Math.floor(new Date(c.created_at).getTime() / 1000);
    const reason = c.reason ?? 'Kein Grund angegeben';

    const embed = new EmbedBuilder()
      .setTitle(`${label} — Case #${c.case_number}`)
      .setColor(color)
      .addFields(
        { name: '👤 User', value: `<@${c.user_id}>`, inline: true },
        { name: '🛡️ Moderator', value: `<@${c.moderator_id}>`, inline: true },
        { name: '📅 Erstellt', value: `<t:${createdSec}:f>`, inline: false },
        { name: '📝 Grund', value: reason, inline: false },
      );

    if (c.parent_case_number) {
      embed.addFields({ name: '🔗 Bezogen auf', value: `Case #${c.parent_case_number}`, inline: true });
    }

    // Stage 2d: Reverse-Lookup auf Report-Quelle (Spec §4.3)
    let linkedReport = null;
    try {
      linkedReport = await reports.getReportByCaseNumber(interaction.guildId, c.case_number);
    } catch (err) {
      console.warn('getReportByCaseNumber failed:', err);
      // fail-soft: zeige Case ohne Quelle-Info
    }
    if (linkedReport) {
      embed.addFields({
        name: '🚨 Quelle',
        value: `Report #${linkedReport.id} von <@${linkedReport.reporter_id}>`,
        inline: false,
      });
    }

    if (c.duration_ms) {
      embed.addFields({ name: '⏱️ Dauer (ms)', value: String(c.duration_ms), inline: true });
    }
    if (c.expires_at) {
      const expSec = Math.floor(new Date(c.expires_at).getTime() / 1000);
      embed.addFields({ name: '📅 Läuft ab', value: `<t:${expSec}:f>`, inline: true });
    }
    embed.addFields(
      { name: '✅ Aktiv', value: c.active ? 'Ja' : 'Nein', inline: true },
      { name: '🔧 Quelle', value: c.source, inline: true },
    );
    embed.setFooter({ text: `🐾 Oreo` }).setTimestamp();

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
