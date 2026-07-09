const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const config = require('../config');

const EMOJIS = [
  { emoji: '🍎', name: 'Apfel' },
  { emoji: '🍌', name: 'Banane' },
  { emoji: '🍇', name: 'Weintraube' },
  { emoji: '🍍', name: 'Ananas' },
  { emoji: '🍒', name: 'Kirsche' },
  { emoji: '🍓', name: 'Erdbeere' },
  { emoji: '🍉', name: 'Wassermelone' },
  { emoji: '🍋', name: 'Zitrone' },
  { emoji: '🍑', name: 'Pfirsich' },
  { emoji: '🥕', name: 'Karotte' },
  { emoji: '🍕', name: 'Pizza' },
  { emoji: '🍔', name: 'Burger' },
];

// Server-seitiger Puzzle-Zustand: `${guildId}:${userId}` → { correctEmoji, options, attempt, expiresAt }
// Die Antwort darf NIE in der customId stehen — Selfbots lesen den Component-Payload direkt aus
// dem Interaction-Objekt und koennten das Captcha sonst ohne echte Loesung automatisiert umgehen.
const pendingPuzzles = new Map();
const PUZZLE_TTL_MS = 15 * 60 * 1000;

function sweepPuzzles() {
  const now = Date.now();
  for (const [key, entry] of pendingPuzzles) {
    if (entry.expiresAt <= now) pendingPuzzles.delete(key);
  }
}

const puzzleSweepInterval = setInterval(sweepPuzzles, 5 * 60 * 1000);
puzzleSweepInterval.unref?.();

function generatePuzzle(guildId, userId, attempt) {
  const targetIndex = Math.floor(Math.random() * EMOJIS.length);
  const target = EMOJIS[targetIndex];

  const decoys = EMOJIS.filter((_, idx) => idx !== targetIndex)
    .sort(() => 0.5 - Math.random())
    .slice(0, 4);

  const options = [target, ...decoys].sort(() => 0.5 - Math.random());

  pendingPuzzles.set(`${guildId}:${userId}`, {
    correctEmoji: target.emoji,
    options: options.map((o) => o.emoji),
    attempt,
    expiresAt: Date.now() + PUZZLE_TTL_MS,
  });

  const embed = new EmbedBuilder()
    .setTitle(`🔐 Captcha-Verifizierung (Versuch ${attempt}/3)`)
    .setColor(0xf1c40f)
    .setDescription(`Bitte klicke auf das Emoji, welches folgendes Symbol darstellt:\n\n👉 **${target.name}** 👈`)
    .setFooter({ text: '🐾 Oreo • Captcha' })
    .setTimestamp();

  const row = new ActionRowBuilder();
  options.forEach((option, index) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`captcha_pick_${userId}_${index}`)
        .setLabel(option.emoji)
        .setStyle(ButtonStyle.Secondary)
    );
  });

  return { embeds: [embed], components: [row] };
}

async function dispatch(interaction) {
  const customId = interaction.customId;

  if (!customId.startsWith('captcha_')) return false;

  if (customId === 'captcha_global_start') {
    try {
      const verifiedRoleIds = await config.getVerifiedRoleIds(interaction.guild.id);
      const isAlreadyVerified = verifiedRoleIds.length > 0
        ? verifiedRoleIds.some(rId => interaction.member.roles.cache.has(rId))
        : false;
      if (isAlreadyVerified) {
        await interaction.reply({
          content: 'Du bist bereits verifiziert!',
          flags: MessageFlags.Ephemeral,
        }).catch(() => null);
        return true;
      }
    } catch (err) {
      console.error('[captcha] Fehler beim Abrufen der verifizierten Rollen (global start):', err);
      await interaction.reply({
        content: 'Ein Fehler ist aufgetreten beim Ueberpruefen der Verifizierung. Bitte versuche es spaeter noch einmal.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => null);
      return true;
    }
    const existing = pendingPuzzles.get(`${interaction.guild.id}:${interaction.user.id}`);
    const attempt = existing && existing.expiresAt > Date.now() ? existing.attempt : 1;
    const puzzle = generatePuzzle(interaction.guild.id, interaction.user.id, attempt);
    await interaction.reply({
      ...puzzle,
      flags: MessageFlags.Ephemeral,
    }).catch(() => null);
    return true;
  }

  const parts = customId.split('_');
  const action = parts[1];
  const targetUserId = parts[2];

  if (interaction.user.id !== targetUserId) {
    await interaction.reply({
      content: '❌ Diese Verifizierung ist nicht für dich gedacht.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => null);
    return true;
  }

  const guild = interaction.guild;
  const member = await guild.members.fetch(targetUserId).catch(() => null);
  if (!member) {
    await interaction.reply({
      content: '❌ Benutzer konnte auf dem Server nicht gefunden werden.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => null);
    return true;
  }

  if (action === 'start') {
    const existing = pendingPuzzles.get(`${guild.id}:${targetUserId}`);
    const attempt = existing && existing.expiresAt > Date.now() ? existing.attempt : 1;
    const puzzle = generatePuzzle(guild.id, targetUserId, attempt);
    await interaction.reply(puzzle);
    return true;
  }

  if (action === 'pick') {
    const key = `${guild.id}:${targetUserId}`;
    const entry = pendingPuzzles.get(key);

    if (!entry || entry.expiresAt <= Date.now()) {
      pendingPuzzles.delete(key);
      await interaction.reply({
        content: '⏳ Dieses Captcha ist abgelaufen. Bitte starte die Verifizierung neu.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => null);
      return true;
    }

    const pickedIndex = parseInt(parts[3], 10);
    const pickedEmoji = entry.options[pickedIndex];
    const attempt = entry.attempt;

    if (pickedEmoji === entry.correctEmoji) {
      pendingPuzzles.delete(key);
      await interaction.deferUpdate();

      let assignedRoleText = '';
      let roleError = null;

      // 1. Assign all verified roles
      try {
        const verifiedRoleIds = await config.getVerifiedRoleIds(guild.id);
        if (verifiedRoleIds.length > 0) {
          const assignedNames = [];
          for (const rId of verifiedRoleIds) {
            const role = guild.roles.cache.get(rId) || await guild.roles.fetch(rId).catch(() => null);
            if (role) {
              await member.roles.add(role, 'Oreo: Captcha erfolgreich gelöst');
              assignedNames.push(`<@&${role.id}>`);
            }
          }
          if (assignedNames.length > 0) {
            assignedRoleText = ` (Rolle(n) ${assignedNames.join(', ')} zugewiesen)`;
          }
        } else {
          // Fallback: Create/assign default 'Member' role if none configured at all
          let role = guild.roles.cache.find((r) => r.name === 'Member');
          if (!role) {
            role = await guild.roles.create({
              name: 'Member',
              color: 0x2ecc71,
              permissions: [PermissionFlagsBits.ViewChannel],
              reason: 'Oreo Verifizierungs-Rolle Setup',
            }).catch(() => null);
            if (role) {
              await config.setVerifiedRoleId(guild.id, role.id);
            }
          }
          if (role) {
            await member.roles.add(role, 'Oreo: Captcha erfolgreich gelöst');
            assignedRoleText = ` (Rolle <@&${role.id}> zugewiesen)`;
          }
        }
      } catch (err) {
        console.error(`[captcha] Failed to assign verified roles to ${targetUserId}:`, err);
        roleError = err;
      }

      // 2. Remove all unverified roles
      try {
        const unverifiedRoleIds = await config.getUnverifiedRoleIds(guild.id);
        if (unverifiedRoleIds.length > 0) {
          const removedNames = [];
          for (const rId of unverifiedRoleIds) {
            const role = guild.roles.cache.get(rId) || await guild.roles.fetch(rId).catch(() => null);
            if (role) {
              await member.roles.remove(role, 'Oreo: Captcha erfolgreich gelöst (Unverified entfernt)');
              removedNames.push(`<@&${role.id}>`);
            }
          }
          if (removedNames.length > 0) {
            assignedRoleText += ` (Rolle(n) ${removedNames.join(', ')} entfernt)`;
          }
        }
      } catch (err) {
        console.error(`[captcha] Failed to remove unverified roles from ${targetUserId}:`, err);
        if (!roleError) roleError = err;
      }

      // 3. Assign all join roles
      try {
        const unverifiedRoleIds = await config.getUnverifiedRoleIds(guild.id);
        const joinRoleIds = (await config.getJoinRoleIds(guild.id)).filter(id => !unverifiedRoleIds.includes(id));
        if (joinRoleIds.length > 0) {
          const joinNames = [];
          for (const rId of joinRoleIds) {
            const role = guild.roles.cache.get(rId) || await guild.roles.fetch(rId).catch(() => null);
            if (role) {
              await member.roles.add(role, 'Oreo: Join-Rolle nach Captcha-Verifizierung zugewiesen');
              joinNames.push(`<@&${role.id}>`);
            }
          }
          if (joinNames.length > 0) {
            assignedRoleText += ` (Beitrittsrolle(n) ${joinNames.join(', ')} zugewiesen)`;
          }
        }
      } catch (err) {
        console.error(`[captcha] Failed to assign join roles to ${targetUserId}:`, err);
        if (!roleError) roleError = err;
      }

      try {
        const channelId = await config.getModLogChannelId(guild.id);
        if (channelId) {
          const logChannel = await guild.channels.fetch(channelId).catch(() => null);
          if (logChannel) {
            const embed = new EmbedBuilder().setTimestamp();

            if (roleError) {
              embed
                .setTitle('⚠️ Verifizierung unvollständig (Rollen-Fehler)')
                .setColor(0xe67e22)
                .setDescription(`Der User <@${member.id}> (${member.user.tag}) hat das Captcha gelöst, aber die Rollen konnten nicht vollständig zugewiesen oder entfernt werden.\n\n**Fehler:** \`${roleError.message}\`\n\n*Bitte stelle sicher, dass die Rolle 'Oreo' in der Rollen-Hierarchie über den zu vergebenden Rollen steht.*`)
                .setFooter({ text: '🐾 Oreo • Captcha-Fehler' });
            } else {
              embed
                .setTitle('✅ User verifiziert')
                .setColor(0x2ecc71)
                .setDescription(`Der User <@${member.id}> (${member.user.tag}) hat das Captcha erfolgreich gelöst${assignedRoleText}.`)
                .setFooter({ text: '🐾 Oreo • Captcha' });
            }

            await logChannel.send({ embeds: [embed] }).catch(() => null);
          }
        }
      } catch (err) {
        console.error('[captcha] failed to send modlog entry:', err);
      }

      const captchaChannelId = await config.getCaptchaChannelId(guild.id);
      const isGlobal = captchaChannelId && (interaction.channel.id === captchaChannelId);

      if (isGlobal) {
        await interaction.editReply({
          content: roleError
            ? `⚠️ **Captcha gelöst, aber Rolle konnte nicht zugewiesen werden:** \`${roleError.message}\`\nBitte wende dich an einen Admin.`
            : '✅ **Erfolgreich verifiziert!** Du hast nun vollen Zugriff auf den Server.',
          embeds: [],
          components: [],
        }).catch(() => null);
      } else {
        setTimeout(async () => {
          await interaction.channel.delete('Oreo: Verifizierung abgeschlossen.').catch(() => null);
        }, 1500);
      }
    } else {
      if (attempt < 3) {
        const puzzle = generatePuzzle(guild.id, targetUserId, attempt + 1);
        await interaction.update({
          content: '❌ Falsches Emoji! Versuche es noch einmal.',
          ...puzzle,
        });
      } else {
        pendingPuzzles.delete(key);
        await interaction.deferUpdate();
        await member.kick('Oreo: Captcha-Verifizierung fehlgeschlagen (3 Fehlversuche)').catch((err) => {
          console.error(`[captcha] Failed to kick user ${targetUserId}:`, err);
        });

        try {
          const channelId = await config.getModLogChannelId(guild.id);
          if (channelId) {
            const logChannel = await guild.channels.fetch(channelId).catch(() => null);
            if (logChannel) {
              const embed = new EmbedBuilder()
                .setTitle('❌ Verifizierung fehlgeschlagen')
                .setColor(0xe74c3c)
                .setDescription(`Der User **${interaction.user.tag}** (${targetUserId}) hat die Verifizierung nach 3 Fehlversuchen nicht bestanden und wurde gekickt.`)
                .setFooter({ text: '🐾 Oreo • Captcha' })
                .setTimestamp();
              await logChannel.send({ embeds: [embed] }).catch(() => null);
            }
          }
        } catch (err) {
          console.error('[captcha] failed to send modlog entry:', err);
        }

        const captchaChannelId = await config.getCaptchaChannelId(guild.id);
        const isGlobal = captchaChannelId && (interaction.channel.id === captchaChannelId);

        if (isGlobal) {
          await interaction.editReply({
            content: '❌ **Verifizierung fehlgeschlagen.** Du wurdest vom Server gekickt.',
            embeds: [],
            components: [],
          }).catch(() => null);
        } else {
          setTimeout(async () => {
            await interaction.channel.delete('Oreo: Verifizierung failed.').catch(() => null);
          }, 1500);
        }
      }
    }
    return true;
  }

  return false;
}

module.exports = { dispatch, _internal: { generatePuzzle, pendingPuzzles } };
