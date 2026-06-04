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

function generatePuzzle(userId, attempt) {
  const targetIndex = Math.floor(Math.random() * EMOJIS.length);
  const target = EMOJIS[targetIndex];

  const decoys = EMOJIS.filter((_, idx) => idx !== targetIndex)
    .sort(() => 0.5 - Math.random())
    .slice(0, 4);

  const options = [
    { ...target, isCorrect: true },
    ...decoys.map((d) => ({ ...d, isCorrect: false })),
  ].sort(() => 0.5 - Math.random());

  const embed = new EmbedBuilder()
    .setTitle(`🔐 Captcha-Verifizierung (Versuch ${attempt}/3)`)
    .setColor(0xf1c40f)
    .setDescription(`Bitte klicke auf das Emoji, welches folgendes Symbol darstellt:\n\n👉 **${target.name}** 👈`)
    .setFooter({ text: '🐾 Oreo • Captcha' })
    .setTimestamp();

  const row = new ActionRowBuilder();
  for (const option of options) {
    const customId = option.isCorrect
      ? `captcha_correct_${userId}_${attempt}_${option.emoji}`
      : `captcha_wrong_${userId}_${attempt}_${option.emoji}`;

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(option.emoji)
        .setStyle(ButtonStyle.Secondary)
    );
  }

  return { embeds: [embed], components: [row] };
}

async function dispatch(interaction) {
  const customId = interaction.customId;

  if (!customId.startsWith('captcha_')) return false;

  if (customId === 'captcha_global_start') {
    const verifiedRoleId = await config.getVerifiedRoleId(interaction.guild.id);
    if (verifiedRoleId && interaction.member.roles.cache.has(verifiedRoleId)) {
      await interaction.reply({
        content: '✅ Du bist bereits verifiziert!',
        flags: MessageFlags.Ephemeral,
      }).catch(() => null);
      return true;
    }
    const puzzle = generatePuzzle(interaction.user.id, 1);
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
    const puzzle = generatePuzzle(targetUserId, 1);
    await interaction.reply({
      ...puzzle,
      ephemeral: false,
    });
    return true;
  }

  const attempt = parseInt(parts[3], 10) || 1;

  if (action === 'correct') {
    await interaction.deferUpdate();

    const verifiedRoleId = await config.getVerifiedRoleId(guild.id);
    let assignedRoleText = '';
    let roleError = null;
    let roleObject = null;

    if (verifiedRoleId) {
      const role = guild.roles.cache.get(verifiedRoleId) || await guild.roles.fetch(verifiedRoleId).catch(() => null);
      if (role) {
        roleObject = role;
        try {
          await member.roles.add(role, 'Oreo: Captcha erfolgreich gelöst');
          assignedRoleText = ` (Rolle <@&${role.id}> zugewiesen)`;
        } catch (err) {
          console.error(`[captcha] Failed to assign role ${verifiedRoleId} to ${targetUserId}:`, err);
          roleError = err;
        }
      }
    } else {
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
        roleObject = role;
        try {
          await member.roles.add(role, 'Oreo: Captcha erfolgreich gelöst');
          assignedRoleText = ` (Rolle <@&${role.id}> zugewiesen)`;
        } catch (err) {
          console.error(`[captcha] Failed to assign role ${role.id} to ${targetUserId}:`, err);
          roleError = err;
        }
      }
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
              .setDescription(`Der User <@${member.id}> (${member.user.tag}) hat das Captcha gelöst, aber die Rolle <@&${roleObject?.id || verifiedRoleId}> konnte nicht zugewiesen werden.\n\n**Fehler:** \`${roleError.message}\`\n\n*Bitte stelle sicher, dass die Rolle 'Oreo' in der Rollen-Hierarchie über der zuzuweisenden Rolle steht.*`)
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

    return true;
  }

  if (action === 'wrong') {
    if (attempt < 3) {
      const puzzle = generatePuzzle(targetUserId, attempt + 1);
      await interaction.update({
        content: '❌ Falsches Emoji! Versuche es noch einmal.',
        ...puzzle,
      });
    } else {
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
    return true;
  }

  return false;
}

module.exports = { dispatch };
