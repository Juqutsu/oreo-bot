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

function actionLabel(action) {
  return action.charAt(0).toUpperCase() + action.slice(1);
}

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

function buildModLogEmbed({ action, caseNumber, target, mod, reason, durationMs }) {
  const fallbackFooter = caseNumber ? `Case #${caseNumber} · 🐾` : 'Case-Eintrag fehlgeschlagen · 🐾';

  if (action === 'warn') {
    return new EmbedBuilder()
      .setTitle('⚠️ User verwarnt')
      .setColor(0xfaa61a)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '👤 User', value: `<@${target.id}>`, inline: false },
        { name: '🛡️ Moderator', value: `<@${mod.id}>`, inline: false },
        { name: '📝 Grund', value: reason ?? 'Kein Grund angegeben', inline: false },
      )
      .setFooter({ text: fallbackFooter })
      .setTimestamp();
  }

  if (action === 'timeout') {
    const expiresAtSec = Math.floor((Date.now() + durationMs) / 1000);
    return new EmbedBuilder()
      .setColor(0xfaa61a)
      .setTitle('⏱️ Timeout vergeben')
      .setThumbnail(target.displayAvatarURL({ dynamic: true }))
      .addFields(
        { name: 'User', value: `<@${target.id}> (${target.username})`, inline: true },
        { name: 'Moderator', value: `<@${mod.id}> (${mod.username})`, inline: true },
        { name: 'Grund', value: reason ?? 'Kein Grund angegeben' },
        { name: 'Dauer', value: formatDuration(durationMs), inline: true },
        { name: 'Läuft ab', value: `<t:${expiresAtSec}:f>`, inline: true },
      )
      .setFooter({ text: fallbackFooter })
      .setTimestamp();
  }

  if (action === 'kick') {
    return new EmbedBuilder()
      .setTitle('User gekickt')
      .setColor(0xed4245)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '👤 User', value: `<@${target.id}>`, inline: false },
        { name: '🛡️ Moderator', value: `<@${mod.id}>`, inline: false },
        { name: '📝 Grund', value: reason ?? 'Kein Grund angegeben', inline: false },
      )
      .setFooter({ text: fallbackFooter })
      .setTimestamp();
  }

  if (action === 'ban') {
    return new EmbedBuilder()
      .setTitle('🔨 User gebannt')
      .setColor(0xed4245)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '👤 User', value: `<@${target.id}>`, inline: false },
        { name: '🛡️ Moderator', value: `<@${mod.id}>`, inline: false },
        { name: '📝 Grund', value: reason ?? 'Kein Grund angegeben', inline: false },
      )
      .setFooter({ text: fallbackFooter })
      .setTimestamp();
  }

  return null; // action === 'none' — no mod-log entry
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

  // Status re-check: another mod may have closed the report between the button click
  // and this select submission. Cheaper to fail here than after the modal submit.
  const report = await reports.getReport(reportId);
  if (!report) {
    return interaction.update({ content: 'Report existiert nicht (mehr).', components: [] });
  }
  if (report.status === 'resolved' || report.status === 'dismissed') {
    return interaction.update({ content: 'Report wurde inzwischen abgeschlossen.', components: [] });
  }

  // Per-action tier:
  const requiredActionTier = (action === 'kick' || action === 'ban') ? 'owner' : 'moderator';
  if (!(await perms.hasTier(interaction.guildId, interaction.member, requiredActionTier))) {
    return interaction.update({
      content: `Aktion **${actionLabel(action)}** benötigt **${requiredActionTier}**-Tier.`,
      components: [],
    });
  }

  // Build action-specific modal
  const modal = new ModalBuilder()
    .setCustomId(`report:modal-resolve:${reportId}:${action}`)
    .setTitle(action === 'none' ? `Report #${reportId} abschließen` : `Resolve: ${actionLabel(action)}`);

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
          .setMinLength(1)
          .setMaxLength(16)
          .setValue('60m'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Grund')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMinLength(1)
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
          .setMinLength(1)
          .setMaxLength(500),
      ),
    );
  }

  await interaction.showModal(modal);
}
async function handleModalResolve(interaction, reportId, action) {
  // Defer ephemeral — Discord requires a response within 3s; we do DB + Discord-API
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // 1. Parse modal fields per action
  const reason = action === 'none' ? null : interaction.fields.getTextInputValue('reason');
  const note   = action === 'none'
    ? (interaction.fields.getTextInputValue('resolution_note') || null)
    : reason;

  let durationMs = null;
  if (action === 'timeout') {
    const durationInput = interaction.fields.getTextInputValue('duration');
    durationMs = parseDuration(durationInput);
    if (!durationMs) {
      return interaction.editReply({ content: 'Ungültige Dauer. Nutze z.B. `30s`, `10m`, `2h`, `1t`, `1w`.' });
    }
    if (durationMs > MAX_TIMEOUT_MS) {
      return interaction.editReply({ content: 'Maximale Timeout-Dauer ist 28 Tage.' });
    }
  }

  // 2. Cheap pre-check
  const report = await reports.getReport(reportId);
  if (!report) {
    return interaction.editReply({ content: 'Report existiert nicht (mehr).' });
  }
  if (report.status === 'resolved' || report.status === 'dismissed') {
    return interaction.editReply({ content: 'Report wurde inzwischen von einem anderen Mod bearbeitet.' });
  }

  // 3. Resolve target
  const targetId = report.reported_user_id.toString();
  const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);
  const targetUser = targetMember?.user
    ?? await interaction.client.users.fetch(targetId).catch(() => null);

  if ((action === 'kick' || action === 'timeout') && !targetMember) {
    return interaction.editReply({ content: 'User ist nicht mehr auf dem Server — Aktion nicht möglich.' });
  }
  if (action !== 'none' && !targetUser) {
    return interaction.editReply({ content: 'User konnte nicht aufgelöst werden.' });
  }

  // 4. Execute Discord-action (warn has none; cases is the only record for warn)
  let caseNumber = null;

  if (action !== 'none') {
    try {
      const auditReason = `${interaction.user.tag}: ${reason}`;
      if (action === 'timeout') await targetMember.timeout(durationMs, auditReason);
      else if (action === 'kick') await targetMember.kick(auditReason);
      else if (action === 'ban')  await interaction.guild.members.ban(targetId, { reason: auditReason });
      // warn → no discord action
    } catch (e) {
      console.error('[report] discord action failed', e);
      return interaction.editReply({ content: `Konnte ${actionLabel(action)} nicht ausführen: ${e?.message ?? 'Discord-Fehler'}.` });
    }

    // 5. Create Case
    try {
      const result = await cases.createCase({
        guildId: interaction.guildId,
        userId: targetId,
        moderatorId: interaction.user.id,
        type: action,
        reason,
        durationMs: action === 'timeout' ? BigInt(durationMs) : undefined,
        expiresAt:  action === 'timeout' ? new Date(Date.now() + durationMs) : undefined,
      });
      caseNumber = result.caseNumber;
    } catch (e) {
      console.error('[report] createCase failed', e);
      return interaction.editReply({
        content: `Aktion ${actionLabel(action)} wurde ausgeführt, aber Case-Erstellung fehlgeschlagen — bitte manuell mit \`/reason\` nachtragen.`,
      });
    }
  }

  // 6. CAS update on reports row
  const pool = getPool();
  let cas;
  try {
    [cas] = await pool.query(
      `UPDATE reports
          SET status='resolved',
              assigned_mod_id=?,
              resolved_at=NOW(),
              resolution_note=?,
              resolution_case_number=?
        WHERE id=? AND status IN ('open','investigating')`,
      [interaction.user.id, note, caseNumber, reportId],
    );
  } catch (e) {
    console.error('[report] CAS update failed', e);
    return interaction.editReply({
      content: action === 'none'
        ? 'Datenbankfehler beim Abschließen — versuch es nochmal.'
        : `Aktion ${actionLabel(action)} ausgeführt (Case #${caseNumber}), aber Report-Status konnte nicht gespeichert werden.`,
    });
  }

  if (cas.affectedRows === 0) {
    // Race lost: another mod already resolved/dismissed
    return interaction.editReply({
      content: action === 'none'
        ? 'Report wurde inzwischen von einem anderen Mod bearbeitet.'
        : `Aktion ${actionLabel(action)} wurde ausgeführt und Case #${caseNumber} erstellt, aber der Report wurde inzwischen von einem anderen Mod abgeschlossen.`,
    });
  }

  // 7. Edit report-channel embed (fail-soft)
  const updatedReport = {
    ...report,
    status: 'resolved',
    assigned_mod_id: interaction.user.id,
    resolution_note: note,
  };
  const reportChannelId = await config.getReportChannelId(interaction.guildId);
  await editReportMessage(interaction.guild, reportChannelId, updatedReport, buildResolvedState(updatedReport, action, caseNumber));

  // 8. Post mod-log embed (fail-soft, only for action !== 'none')
  if (action !== 'none') {
    const modLogChannelId = await config.getModLogChannelId(interaction.guildId).catch(() => null);
    if (modLogChannelId) {
      const modLogChannel = await interaction.client.channels.fetch(modLogChannelId).catch(() => null);
      if (modLogChannel) {
        const modLogEmbed = buildModLogEmbed({
          action, caseNumber,
          target: targetUser,
          mod: interaction.user,
          reason,
          durationMs,
        });
        if (modLogEmbed) {
          await modLogChannel.send({ embeds: [modLogEmbed] })
            .catch(e => console.warn('[report] modlog send failed', e?.code || e));
        }
      }
    }
  }

  // 9. Success ack
  return interaction.editReply({
    content: action === 'none'
      ? `Report #${reportId} ohne Action abgeschlossen.`
      : `Report #${reportId} als **${actionLabel(action)}** resolved (Case #${caseNumber}).`,
  });
}
async function handleDismissOpenModal(interaction, reportId) {
  if (!(await perms.requireTier(interaction, 'moderator'))) return;

  const report = await reports.getReport(reportId);
  if (!report) {
    return interaction.reply({ content: 'Report existiert nicht (mehr).', flags: MessageFlags.Ephemeral });
  }
  if (report.status === 'resolved' || report.status === 'dismissed') {
    return interaction.reply({ content: 'Report ist bereits abgeschlossen.', flags: MessageFlags.Ephemeral });
  }

  const modal = new ModalBuilder()
    .setCustomId(`report:modal-dismiss:${reportId}`)
    .setTitle(`Report #${reportId} verwerfen`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('resolution_note')
          .setLabel('Grund (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500)
          .setPlaceholder('z.B. Doppel-Report, kein Verstoß, …'),
      ),
    );
  await interaction.showModal(modal);
}
async function handleModalDismiss(interaction, reportId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const note = interaction.fields.getTextInputValue('resolution_note') || null;

  // CAS update — atomic guard against concurrent resolve/dismiss
  const pool = getPool();
  let cas;
  try {
    [cas] = await pool.query(
      `UPDATE reports
          SET status='dismissed',
              assigned_mod_id=?,
              resolved_at=NOW(),
              resolution_note=?
        WHERE id=? AND status IN ('open','investigating')`,
      [interaction.user.id, note, reportId],
    );
  } catch (e) {
    console.error('[report] dismiss CAS update failed', e);
    return interaction.editReply({ content: 'Datenbankfehler beim Verwerfen — versuch es nochmal.' });
  }

  if (cas.affectedRows === 0) {
    // Race lost — another mod resolved/dismissed between button click and submit
    return interaction.editReply({ content: 'Report wurde inzwischen von einem anderen Mod bearbeitet.' });
  }

  // Re-read for the embed render (so we have the full row + freshly-set note)
  const report = await reports.getReport(reportId);
  if (report) {
    const channelId = await config.getReportChannelId(interaction.guildId).catch(() => null);
    if (channelId) {
      await editReportMessage(interaction.guild, channelId, report, buildDismissedState(report));
    }
  }

  return interaction.editReply({ content: `Report #${reportId} verworfen.` });
}

module.exports = { dispatch };
