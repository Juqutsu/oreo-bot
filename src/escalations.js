const { getPool } = require('./db');
const { EmbedBuilder } = require('discord.js');
const cases = require('./cases');
const config = require('./config');
const { buildModLogEmbed } = require('./modlog');
const { formatDuration } = require('./duration');

/**
 * Liefert die Eskalations-Regel für eine exakte Warn-Schwelle.
 * @param {string} guildId
 * @param {number} threshold
 * @returns {Promise<object|null>} { id, guild_id, warn_threshold, action, duration_minutes } oder null
 */
async function getRuleForThreshold(guildId, threshold) {
  const [rows] = await getPool().execute(
    `SELECT id, guild_id, warn_threshold, action, duration_minutes
       FROM escalation_rules
      WHERE guild_id = ? AND warn_threshold = ?
      LIMIT 1`,
    [guildId, threshold],
  );
  return rows[0] ?? null;
}

/**
 * Listet alle Eskalations-Regeln einer Guild, sortiert nach Schwelle aufsteigend.
 * @param {string} guildId
 * @returns {Promise<object[]>}
 */
async function listRules(guildId) {
  const [rows] = await getPool().execute(
    `SELECT id, warn_threshold, action, duration_minutes
       FROM escalation_rules
      WHERE guild_id = ?
      ORDER BY warn_threshold ASC`,
    [guildId],
  );
  return rows;
}

/**
 * Setzt oder aktualisiert eine Eskalations-Regel (UPSERT auf uq_threshold_per_guild).
 * @param {string} guildId
 * @param {number} threshold
 * @param {'timeout'|'kick'|'ban'} action
 * @param {number|null} durationMinutes  (nur bei action='timeout' relevant; sonst null)
 * @returns {Promise<void>}
 */
async function setRule(guildId, threshold, action, durationMinutes) {
  await getPool().execute(
    `INSERT INTO escalation_rules (guild_id, warn_threshold, action, duration_minutes)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE action = VALUES(action), duration_minutes = VALUES(duration_minutes)`,
    [guildId, threshold, action, durationMinutes],
  );
}

/**
 * Entfernt eine Eskalations-Regel.
 * @param {string} guildId
 * @param {number} threshold
 * @returns {Promise<number>} affectedRows (0 wenn keine Regel existierte)
 */
async function removeRule(guildId, threshold) {
  const [result] = await getPool().execute(
    `DELETE FROM escalation_rules WHERE guild_id = ? AND warn_threshold = ?`,
    [guildId, threshold],
  );
  return result.affectedRows;
}

/**
 * Prüft ob für den gegebenen active-Warn-Count eine Eskalations-Regel existiert
 * und führt sie aus (Discord-Action + Case + Mod-Log-Embed). Best-effort:
 * Discord-Failure → fail-Embed im Mod-Log, kein Case. Stage 3 Spec §3.
 *
 * @param {object} args
 * @param {import('discord.js').ChatInputCommandInteraction} args.interaction
 * @param {import('discord.js').User} args.target     User aus interaction.options.getUser('user')
 * @param {number} args.activeWarnCount               Aktuelle aktive Warn-Anzahl des targets nach dem Warn
 * @returns {Promise<{caseNumber: number, action: string}|null>}
 *          null wenn keine Regel matched ODER Discord-Action gescheitert ist;
 *          { caseNumber, action } bei erfolgreicher Eskalation.
 */
async function applyEscalation({ interaction, target, activeWarnCount }) {
  const guildId = interaction.guildId;
  const rule = await getRuleForThreshold(guildId, activeWarnCount);
  if (!rule) return null;

  const action = rule.action; // 'timeout' | 'kick' | 'ban'
  const threshold = Number(rule.warn_threshold);
  const durationMinutes = rule.duration_minutes ? Number(rule.duration_minutes) : null;
  const durationMs = action === 'timeout' && durationMinutes ? durationMinutes * 60_000 : null;
  const reason = `Auto-Eskalation (Schwelle: ${threshold} aktive Warns)`;

  // Discord-Action ausführen
  try {
    if (action === 'timeout') {
      const member = await interaction.guild.members.fetch(target.id);
      await member.timeout(durationMs, reason);
    } else if (action === 'kick') {
      const member = await interaction.guild.members.fetch(target.id);
      await member.kick(reason);
    } else if (action === 'ban') {
      await interaction.guild.bans.create(target.id, { reason, deleteMessageSeconds: 0 });
    } else {
      console.warn('applyEscalation: unknown action', action);
      return null;
    }
  } catch (err) {
    await postEscalationFailEmbed({ interaction, target, action, durationMs, threshold, err });
    console.warn(`applyEscalation ${action} failed for guild ${guildId}, user ${target.id}:`, err);
    return null;
  }

  // Case schreiben
  let caseNumber;
  try {
    const result = await cases.createCase({
      guildId,
      userId: target.id,
      moderatorId: interaction.client.user.id,
      type: action,
      reason,
      durationMs,
      expiresAt: durationMs ? new Date(Date.now() + durationMs) : null,
      source: 'escalation',
    });
    caseNumber = result.caseNumber;
  } catch (err) {
    console.error(`applyEscalation: createCase failed after successful Discord action — STATE DRIFT for guild ${guildId}, user ${target.id}:`, err);
    await postEscalationFailEmbed({
      interaction, target, action, durationMs, threshold,
      err: new Error('Case-Schreibung fehlgeschlagen (Discord-Action wurde durchgeführt)'),
    });
    return null;
  }

  // Erfolgs-Mod-Log-Embed posten
  try {
    const modLogChannelId = await config.getModLogChannelId(guildId).catch(() => null);
    if (modLogChannelId) {
      const modLogChannel = await interaction.client.channels.fetch(modLogChannelId).catch(() => null);
      if (modLogChannel) {
        const embed = buildModLogEmbed({
          action,
          caseNumber,
          target,
          mod: interaction.client.user,
          reason,
          durationMs,
        });
        if (embed) {
          await modLogChannel.send({ embeds: [embed] }).catch((e) =>
            console.warn('[escalation] modlog send failed', e?.code || e),
          );
        }
      }
    }
  } catch (err) {
    console.warn('applyEscalation modlog post failed:', err);
  }

  return { caseNumber, action };
}

/**
 * Postet einen Fail-Embed in den Mod-Log-Channel ohne Case zu schreiben.
 * Wird bei Discord-Action-Failure oder Case-Schreibungs-Failure aufgerufen.
 * Best-effort: wenn auch dieser Post scheitert, nur console.warn.
 */
async function postEscalationFailEmbed({ interaction, target, action, durationMs, threshold, err }) {
  try {
    const modLogChannelId = await config.getModLogChannelId(interaction.guildId).catch(() => null);
    if (!modLogChannelId) return;
    const modLogChannel = await interaction.client.channels.fetch(modLogChannelId).catch(() => null);
    if (!modLogChannel) return;

    const actionLabel = action === 'timeout' && durationMs
      ? `${action} (${formatDuration(durationMs)})`
      : action;

    const failEmbed = new EmbedBuilder()
      .setTitle('⚠️ Auto-Eskalation fehlgeschlagen')
      .setColor(0xfaa61a)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '👤 Target', value: `<@${target.id}>`, inline: false },
        { name: '🎯 Geplante Action', value: actionLabel, inline: false },
        { name: '🔢 Bei Schwelle', value: `${threshold} aktive Warns`, inline: true },
        { name: '❌ Grund', value: String(err?.message ?? err).slice(0, 900), inline: false },
      )
      .setFooter({ text: '🐾 Oreo' })
      .setTimestamp();

    await modLogChannel.send({ embeds: [failEmbed] });
  } catch (postErr) {
    console.warn('postEscalationFailEmbed itself failed:', postErr);
  }
}

module.exports = {
  getRuleForThreshold,
  listRules,
  setRule,
  removeRule,
  applyEscalation,
};
