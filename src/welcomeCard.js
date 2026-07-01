const { createCanvas, loadImage } = require('@napi-rs/canvas');

/**
 * Helper to convert hex colors to RGBA.
 */
function hexToRgba(hex, alpha) {
  try {
    const cleanHex = hex.replace('#', '');
    const r = parseInt(cleanHex.substring(0, 2), 16) || 0;
    const g = parseInt(cleanHex.substring(2, 4), 16) || 0;
    const b = parseInt(cleanHex.substring(4, 6), 16) || 0;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  } catch (e) {
    return `rgba(255, 255, 255, ${alpha})`;
  }
}

/**
 * Generates an aesthetic PNG card buffer for welcome or leave events.
 * 
 * @param {import('discord.js').User} user The Discord user object
 * @param {import('discord.js').Guild} guild The Discord guild object
 * @param {'welcome' | 'leave'} type The event type
 * @param {string|null} customBgUrl Optional custom background image URL
 * @returns {Promise<Buffer>} The PNG file buffer
 */
async function generateCard(user, guild, type, customBgUrl = null) {
  const canvas = createCanvas(800, 400);
  const ctx = canvas.getContext('2d');

  // Load colors dynamically
  const config = require('./config');
  let accentColor = '#5865f2';
  let textColor = '#7289da';

  try {
    if (type === 'welcome') {
      accentColor = await config.getWelcomeAccentColor(guild.id);
      textColor = await config.getWelcomeTextColor(guild.id);
    } else {
      accentColor = await config.getLeaveAccentColor(guild.id);
      textColor = await config.getLeaveTextColor(guild.id);
    }
  } catch (err) {
    console.warn('[welcome-card] Failed to load custom colors, falling back to defaults:', err.message);
  }

  // 1. Draw Background
  let bgLoaded = false;
  if (customBgUrl) {
    try {
      const response = await fetch(customBgUrl);
      if (response.ok) {
        const bgBuffer = await response.arrayBuffer();
        const bgImg = await loadImage(Buffer.from(bgBuffer));
        ctx.drawImage(bgImg, 0, 0, 800, 400);
        bgLoaded = true;

        // Apply a dark overlay for custom backgrounds to ensure text readability
        ctx.fillStyle = 'rgba(15, 12, 32, 0.65)';
        ctx.fillRect(0, 0, 800, 400);
      }
    } catch (err) {
      console.error('[welcome-card] Failed to load custom background:', err.message);
    }
  }

  if (!bgLoaded) {
    // Clean dark blue gradient backgrounds
    if (type === 'welcome') {
      const baseGrad = ctx.createLinearGradient(0, 0, 800, 400);
      baseGrad.addColorStop(0, '#080b16');
      baseGrad.addColorStop(1, '#04050a');
      ctx.fillStyle = baseGrad;
      ctx.fillRect(0, 0, 800, 400);

      // Top-Left soft blue glow (using configured accent color)
      const glowTL = ctx.createRadialGradient(0, 0, 0, 0, 0, 400);
      glowTL.addColorStop(0, hexToRgba(accentColor, 0.16));
      glowTL.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = glowTL;
      ctx.fillRect(0, 0, 800, 400);

      // Bottom-Right soft cyan glow (using configured text color)
      const glowBR = ctx.createRadialGradient(800, 400, 0, 800, 400, 400);
      glowBR.addColorStop(0, hexToRgba(textColor, 0.08));
      glowBR.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = glowBR;
      ctx.fillRect(0, 0, 800, 400);
    } else {
      const baseGrad = ctx.createLinearGradient(0, 0, 800, 400);
      baseGrad.addColorStop(0, '#06080f');
      baseGrad.addColorStop(1, '#030406');
      ctx.fillStyle = baseGrad;
      ctx.fillRect(0, 0, 800, 400);

      // Top-Left soft red glow (using accent color)
      const glowTL = ctx.createRadialGradient(0, 0, 0, 0, 0, 400);
      glowTL.addColorStop(0, hexToRgba(accentColor, 0.1));
      glowTL.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = glowTL;
      ctx.fillRect(0, 0, 800, 400);

      // Bottom-Right soft blue glow (using text color)
      const glowBR = ctx.createRadialGradient(800, 400, 0, 800, 400, 400);
      glowBR.addColorStop(0, hexToRgba(textColor, 0.06));
      glowBR.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = glowBR;
      ctx.fillRect(0, 0, 800, 400);
    }
  }

  // 2. Draw Card Border/Frame Outline
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.lineWidth = 2;
  // Rounded rect function manually using bezier curves for compatibility
  ctx.beginPath();
  const radius = 24;
  const x = 16, y = 16, w = 768, h = 368;
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.stroke();

  // 3. Draw Circular Avatar & Neon Glowing Border
  const avatarX = 400;
  const avatarY = 120;
  const avatarRadius = 65;

  // Outer Neon Ring Glow
  ctx.lineWidth = 4;
  ctx.strokeStyle = accentColor;
  ctx.shadowColor = hexToRgba(accentColor, 0.4);
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.arc(avatarX, avatarY, avatarRadius + 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0; // Reset shadow

  // Clip and draw Avatar
  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarX, avatarY, avatarRadius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  let avatarImg = null;
  const avatarUrl = user.displayAvatarURL({ extension: 'png', size: 256 });
  try {
    const response = await fetch(avatarUrl);
    if (response.ok) {
      const buffer = await response.arrayBuffer();
      avatarImg = await loadImage(Buffer.from(buffer));
    }
  } catch (err) {
    console.error('[welcome-card] Failed to fetch user avatar:', err.message);
  }

  if (avatarImg) {
    ctx.drawImage(avatarImg, avatarX - avatarRadius, avatarY - avatarRadius, avatarRadius * 2, avatarRadius * 2);
  } else {
    // Beautiful aesthetic Oreo paw-print fallback avatar
    ctx.fillStyle = type === 'welcome' ? '#1c1736' : '#222228';
    ctx.fillRect(avatarX - avatarRadius, avatarY - avatarRadius, avatarRadius * 2, avatarRadius * 2);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    // Draw central pad
    ctx.beginPath();
    ctx.ellipse(avatarX, avatarY + 10, 22, 17, 0, 0, Math.PI * 2);
    ctx.fill();

    // Draw toe pads
    const toeOffset = [[-15, -12], [-6, -22], [6, -22], [15, -12]];
    for (const [tx, ty] of toeOffset) {
      ctx.beginPath();
      ctx.arc(avatarX + tx, avatarY + ty, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  // 4. Draw Typography
  ctx.textAlign = 'center';
  
  // Header text
  ctx.font = 'bold 20px "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  ctx.fillStyle = textColor;
  let bannerTextTemplate = type === 'welcome' ? 'WILLKOMMEN' : 'AUF WIEDERSEHEN';
  try {
    if (type === 'welcome') {
      bannerTextTemplate = await config.getWelcomeBannerText(guild.id);
    } else {
      bannerTextTemplate = await config.getLeaveBannerText(guild.id);
    }
  } catch (err) {
    console.warn('[welcome-card] Failed to load custom banner text:', err.message);
  }
  const bannerText = bannerTextTemplate
    .replace(/{username}/g, user.username)
    .replace(/{server}/g, guild.name)
    .replace(/{memberCount}/g, guild.memberCount);
  ctx.fillText(bannerText, avatarX, 230);

  // Username text
  ctx.font = 'bold 36px "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  ctx.fillStyle = '#ffffff';
  
  // Measure text to fit long names nicely
  let username = user.username;
  let usernameWidth = ctx.measureText(username).width;
  if (usernameWidth > 680) {
    // Truncate if too long
    while (usernameWidth > 650 && username.length > 5) {
      username = username.slice(0, -1);
      usernameWidth = ctx.measureText(username + '...').width;
    }
    username += '...';
  }
  ctx.fillText(username, avatarX, 285);

  // Subtext / Member count
  ctx.font = '500 16px "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  ctx.fillStyle = '#b9bbbe';
  let subtext = '';
  if (type === 'welcome') {
    subtext = `Du bist unser ${guild.memberCount}. Mitglied!`;
  } else {
    subtext = `Wir haben jetzt ${guild.memberCount} Mitglieder.`;
  }
  ctx.fillText(subtext, avatarX, 330);

  // Watermark/Brand bottom right
  ctx.textAlign = 'right';
  ctx.font = 'bold 12px "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.fillText('HOME', 750, 364);

  return canvas.toBuffer('image/png');
}

/**
 * Formats a template string by replacing placeholders with actual values.
 * 
 * @param {string} template The message template string
 * @param {import('discord.js').GuildMember} member The member object
 * @returns {string} The formatted message
 */
function formatWelcomeMessage(template, member) {
  return template
    .replace(/{user}/g, `<@${member.id}>`)
    .replace(/{username}/g, member.user.username)
    .replace(/{server}/g, member.guild.name)
    .replace(/{memberCount}/g, member.guild.memberCount);
}

module.exports = { generateCard, formatWelcomeMessage };


