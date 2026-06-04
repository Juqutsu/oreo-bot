const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
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
  // Select target
  const targetIndex = Math.floor(Math.random() * EMOJIS.length);
  const target = EMOJIS[targetIndex];

  // Select 4 decoys
  const decoys = EMOJIS.filter((_, idx) => idx !== targetIndex)
    .sort(() => 0.5 - Math.random())
    .slice(0, 4);

  // Combine and shuffle
  const options = [
    { ...target, isCorrect: true },
    ...decoys.map((d) => ({ ...d, isCorrect: false })),
  ].sort(() => 0.5 - Math.random());

  const embed = new EmbedBuilder()
    .setTitle(`🔐 Captcha-Verifizierung (Versuch ${attempt}/3)`)
    .setColor(0xf1c40f) // Yellow
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

  const parts = customId.split('_');
  // captcha_start_[userId]
  // captcha_correct_[userId]_[attempt]_[emoji]
  // captcha_wrong_[userId]_[attempt]_[emoji]
  const action = parts[1];
  const targetUserId = parts[2];

  // Security: only the targeted member can interact
  if (interaction.user.id !== targetUserId) {
    await interaction.reply({
      content: '❌ Diese Verifizierung ist nicht für dich gedacht.',
      ephemeral: true,
    }).catch(() => null);
    return true;
  }

  const guild = interaction.guild;
  const member = await guild.members.fetch(targetUserId).catch(() => null);
  if (!member) {
    await interaction.reply({
      content: '❌ Benutzer konnte auf dem Server nicht gefunden werden.',
      ephemeral: true,
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

    // 1. Assign Role
    const verifiedRoleId = await config.getVerifiedRoleId(guild.id);
    let assignedRoleText = '';
    
    if (verifiedRoleId) {
      const role = guild.roles.cache.get(verifiedRoleId) || await guild.roles.fetch(verifiedRoleId).catch(() => null);
      if (role) {
        await member.roles.add(role, 'Oreo: Captcha erfolgreich gelöst').catch((err) => {
          console.error(`[captcha] Failed to assign role ${verifiedRoleId} to ${targetUserId}:`, err);
        });
        assignedRoleText = ` (Rolle <@&${role.id}> zugewiesen)`;
      }
    } else {
      // Auto-create/find Member role
      let role = guild.roles.cache.find((r) => r.name === 'Member');
      if (!role) {
        role = await guild.roles.create({
          name: 'Member',
          color: 0x2ecc71,
          reason: 'Oreo Verifizierungs-Rolle Setup',
        }).catch(() => null);
        if (role) {
          await config.setVerifiedRoleId(guild.id, role.id);
        }
      }
      if (role) {
        await member.roles.add(role, 'Oreo: Captcha erfolgreich gelöst').catch(() => null);
        assignedRoleText = ` (Rolle <@&${role.id}> zugewiesen)`;
      }
    }

    // 2. Modlog
    try {
      const channelId = await config.getModLogChannelId(guild.id);
      if (channelId) {
        const logChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (logChannel) {
          const embed = new EmbedBuilder()
            .setTitle('✅ User verifiziert')
            .setColor(0x2ecc71)
            .setDescription(`Der User <@${member.id}> (${member.user.tag}) hat das Captcha erfolgreich gelöst${assignedRoleText}.`)
            .setFooter({ text: '🐾 Oreo • Captcha' })
            .setTimestamp();
          await logChannel.send({ embeds: [embed] }).catch(() => null);
        }
      }
    } catch (err) {
      console.error('[captcha] failed to send modlog entry:', err);
    }

    // 3. Delete channel
    setTimeout(async () => {
      await interaction.channel.delete('Oreo: Verifizierung abgeschlossen.').catch(() => null);
    }, 1500);

    return true;
  }

  if (action === 'wrong') {
    if (attempt < 3) {
      // Show next puzzle
      const puzzle = generatePuzzle(targetUserId, attempt + 1);
      await interaction.reply({
        content: '❌ Falsches Emoji! Versuche es noch einmal.',
        ...puzzle,
        ephemeral: false,
      });
    } else {
      await interaction.deferUpdate();
      // Kick member
      await member.kick('Oreo: Captcha-Verifizierung fehlgeschlagen (3 Fehlversuche)').catch((err) => {
        console.error(`[captcha] Failed to kick user ${targetUserId}:`, err);
      });

      // Modlog
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

      // Delete channel
      setTimeout(async () => {
        await interaction.channel.delete('Oreo: Verifizierung fehlgeschlagen.').catch(() => null);
      }, 1500);
    }
    return true;
  }

  return false;
}

module.exports = { dispatch };
