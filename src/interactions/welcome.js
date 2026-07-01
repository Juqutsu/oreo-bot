const { EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../config');
const perms = require('../perms');

const HEX_COLOR_REGEX = /^#[0-9A-F]{6}$/i;

async function dispatch(interaction) {
  if (!interaction.customId) return false;
  const parts = interaction.customId.split(':');
  
  if (parts[0] === 'welcome' && parts[1] === 'config_modal' && interaction.isModalSubmit()) {
    await handleWelcomeModalSubmit(interaction);
    return true;
  }
  
  if (parts[0] === 'leave' && parts[1] === 'config_modal' && interaction.isModalSubmit()) {
    await handleLeaveModalSubmit(interaction);
    return true;
  }
  
  return false;
}

async function handleWelcomeModalSubmit(interaction) {
  if (!(await perms.requireTier(interaction, 'owner'))) return;

  const message = interaction.fields.getTextInputValue('message').trim();
  const background = interaction.fields.getTextInputValue('background').trim();
  const accent = interaction.fields.getTextInputValue('accent').trim();
  const textcolor = interaction.fields.getTextInputValue('textcolor').trim();
  const bannerText = interaction.fields.getTextInputValue('bannertext').trim();

  // Validate hex colors
  if (accent && !HEX_COLOR_REGEX.test(accent)) {
    return interaction.reply({
      content: '❌ Die Akzentfarbe muss ein gültiger Hex-Code sein (z.B. `#5865f2`).',
      flags: MessageFlags.Ephemeral
    });
  }

  if (textcolor && !HEX_COLOR_REGEX.test(textcolor)) {
    return interaction.reply({
      content: '❌ Die Textfarbe muss ein gültiger Hex-Code sein (z.B. `#7289da`).',
      flags: MessageFlags.Ephemeral
    });
  }

  const cleanBg = background === 'none' || background === '' ? null : background;

  try {
    if (message) await config.setWelcomeMessage(interaction.guildId, message);
    await config.setWelcomeBgUrl(interaction.guildId, cleanBg);
    if (accent) await config.setWelcomeAccentColor(interaction.guildId, accent);
    if (textcolor) await config.setWelcomeTextColor(interaction.guildId, textcolor);
    await config.setWelcomeBannerText(interaction.guildId, bannerText);
  } catch (err) {
    console.error('[welcome-interaction] Modal save error:', err);
    return interaction.reply({
      content: '❌ Datenbankfehler beim Speichern der Einstellungen.',
      flags: MessageFlags.Ephemeral
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('✅ Willkommens-Design aktualisiert')
    .setColor(accent ? parseInt(accent.replace('#', ''), 16) : 0x5865f2)
    .addFields(
      { name: '📝 Nachricht', value: message || '(Standard)', inline: false },
      { name: '🖼️ Hintergrund', value: cleanBg ? `[Link](${cleanBg})` : 'Standard-Verlauf', inline: true },
      { name: '🎨 Akzentfarbe', value: accent || '#5865f2', inline: true },
      { name: '✏️ Textfarbe', value: textcolor || '#7289da', inline: true },
      { name: '🖼️ Banner-Text', value: bannerText || 'WILLKOMMEN', inline: true }
    )
    .setFooter({ text: '🐾 Oreo • Design' })
    .setTimestamp();

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleLeaveModalSubmit(interaction) {
  if (!(await perms.requireTier(interaction, 'owner'))) return;

  const message = interaction.fields.getTextInputValue('message').trim();
  const background = interaction.fields.getTextInputValue('background').trim();
  const accent = interaction.fields.getTextInputValue('accent').trim();
  const textcolor = interaction.fields.getTextInputValue('textcolor').trim();
  const bannerText = interaction.fields.getTextInputValue('bannertext').trim();

  // Validate hex colors
  if (accent && !HEX_COLOR_REGEX.test(accent)) {
    return interaction.reply({
      content: '❌ Die Akzentfarbe muss ein gültiger Hex-Code sein (z.B. `#e74c3c`).',
      flags: MessageFlags.Ephemeral
    });
  }

  if (textcolor && !HEX_COLOR_REGEX.test(textcolor)) {
    return interaction.reply({
      content: '❌ Die Textfarbe muss ein gültiger Hex-Code sein (z.B. `#e74c3c`).',
      flags: MessageFlags.Ephemeral
    });
  }

  const cleanBg = background === 'none' || background === '' ? null : background;

  try {
    if (message) await config.setLeaveMessage(interaction.guildId, message);
    await config.setLeaveBgUrl(interaction.guildId, cleanBg);
    if (accent) await config.setLeaveAccentColor(interaction.guildId, accent);
    if (textcolor) await config.setLeaveTextColor(interaction.guildId, textcolor);
    await config.setLeaveBannerText(interaction.guildId, bannerText);
  } catch (err) {
    console.error('[leave-interaction] Modal save error:', err);
    return interaction.reply({
      content: '❌ Datenbankfehler beim Speichern der Einstellungen.',
      flags: MessageFlags.Ephemeral
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('✅ Leave-Design aktualisiert')
    .setColor(accent ? parseInt(accent.replace('#', ''), 16) : 0xe74c3c)
    .addFields(
      { name: '📝 Nachricht', value: message || '(Standard)', inline: false },
      { name: '🖼️ Hintergrund', value: cleanBg ? `[Link](${cleanBg})` : 'Standard-Verlauf', inline: true },
      { name: '🎨 Akzentfarbe', value: accent || '#e74c3c', inline: true },
      { name: '✏️ Textfarbe', value: textcolor || '#e74c3c', inline: true },
      { name: '🖼️ Banner-Text', value: bannerText || 'AUF WIEDERSEHEN', inline: true }
    )
    .setFooter({ text: '🐾 Oreo • Design' })
    .setTimestamp();

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

module.exports = { dispatch };
