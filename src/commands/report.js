const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const reports = require('../reports');
const config = require('../config');

const COLOR_OPEN = 0xFEE75C;

function buildOpenEmbed(reportId, reporter, target, reason, evidenceUrl, createdAtMs) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_OPEN)
    .setTitle(`🆕 Report #${reportId}`)
    .addFields(
      { name: 'Gemeldeter User', value: `${target} (${target.id})`, inline: true },
      { name: 'Reporter', value: `${reporter} (${reporter.id})`, inline: true },
      { name: 'Grund', value: reason },
    );
  if (evidenceUrl) {
    embed.addFields({ name: 'Evidence', value: `[Link](${evidenceUrl})` });
  }
  embed.addFields(
    { name: 'Status', value: '🟡 Offen', inline: true },
    { name: 'Eingegangen', value: `<t:${Math.floor(createdAtMs / 1000)}:R>`, inline: true },
  );
  return embed;
}

function buildOpenButtons(reportId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`report:claim:${reportId}`).setLabel('Übernehmen').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`report:resolve:${reportId}`).setLabel('Resolve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`report:dismiss:${reportId}`).setLabel('Verwerfen').setStyle(ButtonStyle.Danger),
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('report')
    .setDescription('Meldet einen User an die Moderation.')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Wer soll gemeldet werden?').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Was ist passiert? (max 500 Zeichen)').setRequired(true).setMaxLength(500))
    .addStringOption(o => o.setName('evidence_url').setDescription('Optional: Link zu Screenshot oder Nachricht').setRequired(false).setMaxLength(500)),

  // KEIN requiredTier — jeder Member darf reporten

  async execute(interaction) {
    const guildId = interaction.guildId;
    const reporter = interaction.user;
    const target = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason', true);
    const evidenceUrl = interaction.options.getString('evidence_url') ?? null;

    // 1a) report_channel configured?
    const channelId = await config.getReportChannelId(guildId);
    if (!channelId) {
      return interaction.reply({
        content: 'Report-System ist nicht aktiv. Bitte ein Admin: `/config channel set type:report channel:#...`',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 1b) self-report
    if (target.id === reporter.id) {
      return interaction.reply({ content: 'Du kannst dich nicht selbst melden.', flags: MessageFlags.Ephemeral });
    }

    // 1c) bot-report
    if (target.bot) {
      return interaction.reply({ content: 'Bots können nicht gemeldet werden.', flags: MessageFlags.Ephemeral });
    }

    // 1d) target on server?
    const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (!targetMember) {
      return interaction.reply({ content: 'User ist nicht (mehr) auf dem Server.', flags: MessageFlags.Ephemeral });
    }

    // 2) cooldown
    const remainingMs = reports.checkCooldown(reporter.id);
    if (remainingMs > 0) {
      return interaction.reply({
        content: `Bitte warte noch ${Math.ceil(remainingMs / 1000)}s vor dem nächsten Report.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // 3) duplicate
    const isDup = await reports.hasOpenReportFromTo(guildId, reporter.id, target.id);
    if (isDup) {
      return interaction.reply({
        content: 'Du hast bereits einen offenen Report gegen diesen User.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 4) evidence url shape
    if (evidenceUrl && !(evidenceUrl.startsWith('http://') || evidenceUrl.startsWith('https://'))) {
      return interaction.reply({
        content: 'Evidence muss mit http:// oder https:// beginnen.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 5) insert
    let reportId;
    try {
      reportId = await reports.createReport({
        guildId,
        reporterId: reporter.id,
        reportedUserId: target.id,
        reason,
        evidenceUrl,
      });
    } catch (e) {
      console.error('[report] createReport failed', e);
      return interaction.reply({ content: 'Fehler beim Speichern des Reports.', flags: MessageFlags.Ephemeral });
    }

    // 6) post embed in report_channel
    const reportChannel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!reportChannel) {
      return interaction.reply({
        content: 'Der konfigurierte Report-Channel existiert nicht mehr. Bitte Admin informieren.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const embed = buildOpenEmbed(reportId, reporter, target, reason, evidenceUrl, Date.now());
    const row = buildOpenButtons(reportId);
    try {
      const msg = await reportChannel.send({ embeds: [embed], components: [row] });
      await reports.attachMessageId(reportId, msg.id);
    } catch (e) {
      console.warn('[report] cannot post to report channel', e?.code || e);
      return interaction.reply({
        content: 'Der Bot kann nicht in den Report-Channel posten. Bitte Admin informieren.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 7) cooldown + ack
    reports.touchCooldown(reporter.id);
    return interaction.reply({
      content: `✅ Report #${reportId} eingereicht. Die Moderation wird sich kümmern.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
