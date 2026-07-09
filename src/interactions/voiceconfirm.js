const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const perms = require('../perms');
const cases = require('../cases');
const config = require('../config');
const { buildModLogEmbed } = require('../modlog');

// Bestätigungs-Anfragen für destruktive Sprachbefehle (Lockdown/Voice-Mute).
// Gleiche Map+TTL+unref'd-Sweeper-Form wie `previewSessions` (announcement.js) und
// `pendingPuzzles` (captcha.js) — verworfen bei Neustart, das ist hier ok (Ansage
// läuft ohnehin nach 60s ab).
// pendingId → { action: 'lockdown'|'mute', guildId, voiceChannelId, requesterId, targetId|null, expiresAt }
const pending = new Map();
const CONFIRM_TTL_MS = 60 * 1000;
let nextId = 1;

function sweepPending() {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(id);
  }
}

const sweepInterval = setInterval(sweepPending, 60 * 1000);
sweepInterval.unref?.();

/** Postet eine Bestätigungs-Anfrage für eine destruktive Sprach-Aktion. */
async function requestConfirmation({ textChannel, voiceChannel, requester, action, targetMember = null }) {
  const id = String(nextId++);
  pending.set(id, {
    action,
    guildId: voiceChannel.guild.id,
    voiceChannelId: voiceChannel.id,
    requesterId: requester.id,
    targetId: targetMember?.id ?? null,
    expiresAt: Date.now() + CONFIRM_TTL_MS,
  });

  const label = action === 'lockdown'
    ? `🔒 Voice-Lockdown für **${voiceChannel.name}** (alle Nicht-Team-Mitglieder werden gemutet)`
    : `🔇 5-Minuten-Timeout für <@${targetMember.id}>`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`voiceconfirm:ok:${id}`).setLabel('Bestätigen').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`voiceconfirm:no:${id}`).setLabel('Abbrechen').setStyle(ButtonStyle.Secondary),
  );

  await textChannel.send({
    content: `🐾 <@${requester.id}> hat per Sprachbefehl angefordert: ${label}\nBestätige innerhalb von 60 Sekunden.`,
    components: [row],
  });
}

async function dispatch(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('voiceconfirm:')) return false;

  const [, verb, id] = interaction.customId.split(':');
  const entry = pending.get(id);

  if (!entry || entry.expiresAt <= Date.now()) {
    pending.delete(id);
    await interaction.update({ content: '⏳ Diese Bestätigung ist abgelaufen.', components: [] }).catch(() => null);
    return true;
  }

  // Nur Anforderer oder Team (Supporter+) darf klicken.
  const isRequester = interaction.user.id === entry.requesterId;
  const isStaff = isRequester ? true : await perms.hasTier(entry.guildId, interaction.member, 'supporter').catch(() => false);
  if (!isRequester && !isStaff) {
    await interaction.reply({ content: '❌ Diese Bestätigung ist nicht für dich.', flags: MessageFlags.Ephemeral }).catch(() => null);
    return true;
  }

  // Synchroner Claim (kein await zwischen Read und Write) schließt die Doppelklick-Race:
  // zwei nahezu gleichzeitige Klicks kommen beide an dieser Stelle an, aber nur der erste
  // sieht entry.claimed === falsy und setzt es synchron auf true, bevor der zweite drankommt
  // (gleiche Idee wie `session.posting` in announcement.js).
  if (entry.claimed) {
    await interaction.reply({ content: '⏳ Diese Bestätigung wird bereits bearbeitet.', flags: MessageFlags.Ephemeral }).catch(() => null);
    return true;
  }
  entry.claimed = true;

  pending.delete(id);

  if (verb === 'no') {
    await interaction.update({ content: '✅ Aktion abgebrochen.', components: [] }).catch(() => null);
    return true;
  }

  const guild = interaction.guild;
  const voiceChannel = await guild.channels.fetch(entry.voiceChannelId).catch(() => null);
  if (!voiceChannel) {
    await interaction.update({ content: '❌ Voice-Kanal nicht mehr gefunden.', components: [] }).catch(() => null);
    return true;
  }

  if (entry.action === 'lockdown') {
    await voiceChannel.permissionOverwrites.edit(guild.roles.everyone, { Speak: false }).catch(() => {});
    let mutedCount = 0;
    for (const m of voiceChannel.members.values()) {
      if (m.user.bot) continue;
      const targetIsStaff = await perms.hasTier(entry.guildId, m, 'supporter').catch(() => false);
      if (!targetIsStaff) {
        await m.voice.setMute(true, 'Oreo Sprach-Lockdown (bestätigt)').catch(() => {});
        mutedCount++;
      }
    }
    await interaction.update({
      content: `🔒 **Voice-Lockdown** in **${voiceChannel.name}** durch <@${entry.requesterId}> bestätigt. ${mutedCount} User gemutet. Aufheben mit "Oreo unlock".`,
      components: [],
    }).catch(() => null);
    return true;
  }

  if (entry.action === 'mute') {
    const targetMember = await guild.members.fetch(entry.targetId).catch(() => null);
    if (!targetMember) {
      await interaction.update({ content: '❌ Ziel-User nicht mehr auf dem Server.', components: [] }).catch(() => null);
      return true;
    }
    // Frische Team-Prüfung zum Ausführungszeitpunkt (Lockdown-Zweig macht das pro Mitglied
    // bereits so) — das Ziel kann zwischen Sprachbefehl und Bestätigung befördert worden sein.
    const targetIsStaff = await perms.hasTier(entry.guildId, targetMember, 'supporter').catch(() => false);
    if (targetIsStaff) {
      await interaction.update({ content: '❌ Ziel ist inzwischen Teammitglied — Mute abgebrochen.', components: [] }).catch(() => null);
      return true;
    }
    const durationMs = 5 * 60 * 1000;
    await targetMember.timeout(durationMs, `Sprach-Mute durch ${interaction.user.tag} (bestätigt)`).catch(() => {});
    await targetMember.voice.setMute(true, `Sprach-Mute durch ${interaction.user.tag}`).catch(() => {});

    let caseNumber = null;
    try {
      const result = await cases.createCase({
        guildId: entry.guildId,
        userId: targetMember.id,
        moderatorId: entry.requesterId,
        type: 'timeout',
        reason: 'Sprachbefehl: Voice-Mute (5 Minuten)',
        durationMs: BigInt(durationMs),
        expiresInMs: durationMs,
      });
      caseNumber = result.caseNumber;
    } catch (err) {
      console.error('[voiceconfirm] createCase failed:', err);
    }

    try {
      const channelId = await config.getModLogChannelId(entry.guildId);
      if (channelId) {
        const logChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (logChannel) {
          const embed = buildModLogEmbed({
            action: 'timeout',
            caseNumber,
            target: targetMember.user,
            mod: interaction.user,
            reason: 'Sprachbefehl: Voice-Mute',
            durationMs,
          });
          if (embed) await logChannel.send({ embeds: [embed] }).catch(() => null);
        }
      }
    } catch (logErr) {
      console.warn('[voiceconfirm] modlog failed:', logErr);
    }

    await interaction.update({
      content: `🔇 <@${targetMember.id}> wurde für 5 Minuten stummgeschaltet (Case #${caseNumber ?? '—'}).`,
      components: [],
    }).catch(() => null);
    return true;
  }

  return true;
}

module.exports = { dispatch, requestConfirmation, _internal: { pending, CONFIRM_TTL_MS, sweepPending } };
