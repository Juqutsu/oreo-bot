const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');
const reports = require('../reports');
const perms = require('../perms');
const config = require('../config');
const cases = require('../cases');
const { parseDuration, formatDuration, MAX_TIMEOUT_MS } = require('../duration');
const { getPool } = require('../db');

const COLOR_OPEN          = 0xFEE75C;
const COLOR_INVESTIGATING = 0x5865F2;
const COLOR_RESOLVED_CASE = 0x57F287;
const COLOR_RESOLVED_NONE = 0x95A5A6;
const COLOR_DISMISSED     = 0xED4245;

// ---------- Dispatcher ----------

async function dispatch(interaction) {
  if (!interaction.customId) return false;
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'report') return false;
  const kind = parts[1];
  const reportId = Number(parts[2]);
  if (!Number.isFinite(reportId)) return false;

  if (kind === 'claim'         && interaction.isButton())            { await handleClaim(interaction, reportId); return true; }
  if (kind === 'resolve'       && interaction.isButton())            { await handleResolveOpenSelect(interaction, reportId); return true; }
  if (kind === 'dismiss'       && interaction.isButton())            { await handleDismissOpenModal(interaction, reportId); return true; }
  if (kind === 'action-select' && interaction.isStringSelectMenu())  { await handleActionSelect(interaction, reportId); return true; }
  if (kind === 'modal-resolve' && interaction.isModalSubmit())       { await handleModalResolve(interaction, reportId, parts[3]); return true; }
  if (kind === 'modal-dismiss' && interaction.isModalSubmit())       { await handleModalDismiss(interaction, reportId); return true; }

  console.warn(`[report] unhandled customId kind=${kind} reportId=${reportId} interactionType=${interaction.type}`);
  return false;
}

// ---------- Embed builders (used by all handlers) ----------

function buildEmbedBase(report) {
  const embed = new EmbedBuilder()
    .setTitle(`Report #${report.id}`)
    .addFields(
      { name: 'Gemeldeter User', value: `<@${report.reported_user_id}> (${report.reported_user_id})`, inline: true },
      { name: 'Reporter', value: `<@${report.reporter_id}> (${report.reporter_id})`, inline: true },
      { name: 'Grund', value: report.reason },
    );
  if (report.evidence_url) {
    embed.addFields({ name: 'Evidence', value: `[Link](${report.evidence_url})` });
  }
  embed.addFields({ name: 'Eingegangen', value: `<t:${Math.floor(new Date(report.created_at).getTime() / 1000)}:R>`, inline: true });
  return embed;
}

function buildClaimedState(report) {
  const embed = buildEmbedBase(report)
    .setColor(COLOR_INVESTIGATING)
    .setTitle(`🔵 Report #${report.id}`)
    .addFields({ name: 'Status', value: `🔵 In Bearbeitung von <@${report.assigned_mod_id}>`, inline: true });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`report:resolve:${report.id}`).setLabel('Resolve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`report:dismiss:${report.id}`).setLabel('Verwerfen').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

function buildResolvedState(report, action, caseNumber) {
  const isNone = action === 'none';
  const embed = buildEmbedBase(report)
    .setColor(isNone ? COLOR_RESOLVED_NONE : COLOR_RESOLVED_CASE)
    .setTitle(`✅ Report #${report.id}`);
  const statusValue = isNone
    ? `✅ Resolved von <@${report.assigned_mod_id}> → Keine Action`
    : `✅ Resolved von <@${report.assigned_mod_id}> → ${action} (Case #${caseNumber})`;
  embed.addFields({ name: 'Status', value: statusValue, inline: true });
  if (report.resolution_note) embed.setFooter({ text: report.resolution_note });
  return { embeds: [embed], components: [] };
}

function buildDismissedState(report) {
  const embed = buildEmbedBase(report)
    .setColor(COLOR_DISMISSED)
    .setTitle(`🚫 Report #${report.id}`)
    .addFields({ name: 'Status', value: `🚫 Verworfen von <@${report.assigned_mod_id}>`, inline: true });
  if (report.resolution_note) embed.setFooter({ text: report.resolution_note });
  return { embeds: [embed], components: [] };
}

async function editReportMessage(guild, channelId, report, newState) {
  if (!report.message_id) return false; // fail-soft: no message to edit
  try {
    const channel = await guild.channels.fetch(channelId);
    const msg = await channel.messages.fetch(report.message_id.toString());
    await msg.edit(newState);
    return true;
  } catch (e) {
    console.warn(`[report] cannot edit report message ${report.message_id}`, e?.code || e);
    return false;
  }
}

// ---------- handleClaim ----------

async function handleClaim(interaction, reportId) {
  if (!(await perms.requireTier(interaction, 'moderator'))) return;

  const pool = getPool();
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const report = await reports.getReport(reportId, { forUpdate: true, conn });
    if (!report) {
      await conn.rollback();
      return interaction.reply({ content: 'Report existiert nicht (mehr).', flags: MessageFlags.Ephemeral });
    }
    if (report.status === 'resolved' || report.status === 'dismissed') {
      await conn.rollback();
      return interaction.reply({ content: 'Report ist bereits abgeschlossen.', flags: MessageFlags.Ephemeral });
    }

    // Re-claim by same mod = idempotent ack
    if (report.status === 'investigating' && report.assigned_mod_id?.toString() === interaction.user.id) {
      await conn.rollback();
      return interaction.reply({ content: `Du hast Report #${reportId} bereits übernommen.`, flags: MessageFlags.Ephemeral });
    }

    await reports.claimReport(reportId, interaction.user.id, { conn });
    await conn.commit();

    const updated = { ...report, status: 'investigating', assigned_mod_id: interaction.user.id };
    const channelId = await config.getReportChannelId(interaction.guildId);
    await editReportMessage(interaction.guild, channelId, updated, buildClaimedState(updated));
    return interaction.reply({ content: `Du übernimmst Report #${reportId}.`, flags: MessageFlags.Ephemeral });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('[report] handleClaim error', e);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Fehler bei Übernehmen.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  } finally {
    if (conn) conn.release();
  }
}

// ---------- Stub handlers (implemented in Tasks 5b / 5c / 5d) ----------

async function handleResolveOpenSelect(interaction, reportId) {
  if (!(await perms.requireTier(interaction, 'moderator'))) return;

  const report = await reports.getReport(reportId);
  if (!report) {
    return interaction.reply({ content: 'Report existiert nicht (mehr).', flags: MessageFlags.Ephemeral });
  }
  if (report.status === 'resolved' || report.status === 'dismissed') {
    return interaction.reply({ content: 'Report ist bereits abgeschlossen.', flags: MessageFlags.Ephemeral });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`report:action-select:${reportId}`)
    .setPlaceholder('Aktion wählen')
    .addOptions(
      { label: 'None',    value: 'none',    description: 'Report ohne Action abschließen', emoji: '✅' },
      { label: 'Warn',    value: 'warn',    description: 'Verwarnung aussprechen',         emoji: '⚠️' },
      { label: 'Timeout', value: 'timeout', description: 'User timeout-en',                emoji: '⏱️' },
      { label: 'Kick',    value: 'kick',    description: 'User kicken (owner-Tier)',       emoji: '👢' },
      { label: 'Ban',     value: 'ban',     description: 'User bannen (owner-Tier)',       emoji: '🔨' },
    );

  return interaction.reply({
    content: 'Aktion wählen:',
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}
async function handleActionSelect(interaction, reportId) {
  const action = interaction.values[0]; // 'none' | 'warn' | 'timeout' | 'kick' | 'ban'

  // Per-action tier:
  const requiredActionTier = (action === 'kick' || action === 'ban') ? 'owner' : 'moderator';
  if (!(await perms.hasTier(interaction.member, requiredActionTier))) {
    return interaction.update({
      content: `Aktion **${action}** benötigt **${requiredActionTier}**-Tier.`,
      components: [],
    });
  }

  // Build action-specific modal
  const modal = new ModalBuilder()
    .setCustomId(`report:modal-resolve:${reportId}:${action}`)
    .setTitle(action === 'none' ? `Report #${reportId} abschließen` : `Resolve: ${action}`);

  if (action === 'none') {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('resolution_note')
          .setLabel('Notiz (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500),
      ),
    );
  } else if (action === 'timeout') {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('duration')
          .setLabel('Dauer (z.B. 30s, 10m, 2h, 1t, 1w)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(16)
          .setValue('60m'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Grund')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500),
      ),
    );
  } else {
    // warn / kick / ban → just reason
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Grund')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500),
      ),
    );
  }

  await interaction.showModal(modal);
}
async function handleModalResolve(interaction, reportId, action) {
  return interaction.reply({ content: '(not yet implemented — Task 5c)', flags: MessageFlags.Ephemeral });
}
async function handleDismissOpenModal(interaction, reportId) {
  return interaction.reply({ content: '(not yet implemented — Task 5d)', flags: MessageFlags.Ephemeral });
}
async function handleModalDismiss(interaction, reportId) {
  return interaction.reply({ content: '(not yet implemented — Task 5d)', flags: MessageFlags.Ephemeral });
}

module.exports = { dispatch };
