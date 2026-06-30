const { Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const { formatDuration } = require('../duration');

// Anti-Raid State
const joinTracker = new Map();
const raidStatus = new Map();
const RAID_THRESHOLD_COUNT = 5;
const RAID_THRESHOLD_SECONDS = 10;
const RAID_COOLDOWN_MS = 15 * 60 * 1000;

async function execute(member) {
  if (member.user.bot) return;

  const guildId = member.guild.id;

  // Anti-Raid Join Speed Check
  let isRaidActive = false;
  try {
    const now = Date.now();
    
    // Clean up expired panic mode
    const currentRaid = raidStatus.get(guildId);
    if (currentRaid && currentRaid.active && now > currentRaid.expiresAt) {
      raidStatus.set(guildId, { active: false, expiresAt: 0 });
      console.log(`[anti-raid] Panic mode expired for guild ${guildId}`);
    }

    if (!joinTracker.has(guildId)) {
      joinTracker.set(guildId, []);
    }
    const joins = joinTracker.get(guildId);
    joins.push(now);

    const windowStart = now - (RAID_THRESHOLD_SECONDS * 1000);
    const recentJoins = joins.filter(t => t >= windowStart);
    joinTracker.set(guildId, recentJoins);

    if (recentJoins.length >= RAID_THRESHOLD_COUNT) {
      const wasActive = raidStatus.get(guildId)?.active;
      if (!wasActive) {
        raidStatus.set(guildId, { active: true, expiresAt: now + RAID_COOLDOWN_MS });
        
        // Alert moderators
        const logChannelId = await config.getModLogChannelId(guildId);
        if (logChannelId) {
          const logChannel = await member.guild.channels.fetch(logChannelId).catch(() => null);
          if (logChannel) {
            const embed = new EmbedBuilder()
              .setTitle('🚨 RAID-ALARM FEUERT!')
              .setColor(0xed4245)
              .setDescription(`Es wurden **${recentJoins.length} Beitritte in weniger als ${RAID_THRESHOLD_SECONDS} Sekunden** erkannt!`)
              .addFields(
                { name: '🔥 Status', value: 'Server befindet sich im **Panik-Modus (15 Minuten)**.', inline: true },
                { name: '🔒 Schutzmaßnahme', value: 'Captcha-Verifizierung wird temporär für ALLE neuen User erzwungen.', inline: true }
              )
              .setTimestamp()
              .setFooter({ text: '🐾 Oreo Anti-Raid' });
            await logChannel.send({ content: '@here 🚨 **Möglicher Raid erkannt!**', embeds: [embed] }).catch(() => null);
          }
        }
      }
      isRaidActive = true;
    } else {
      isRaidActive = raidStatus.get(guildId)?.active ?? false;
    }
  } catch (err) {
    console.error('[anti-raid] Join speed check failed:', err);
  }

  try {
    const minDays = await config.getMinAccountAgeDays(guildId);
    if (minDays > 0) {
      const ageMs = Date.now() - member.user.createdAt.getTime();
      const limitMs = minDays * 24 * 60 * 60 * 1000;

      if (ageMs < limitMs) {
        const channelId = await config.getModLogChannelId(guildId);
        if (channelId) {
          const logChannel = await member.guild.channels.fetch(channelId).catch(() => null);
          if (logChannel) {
            const createdSec = Math.floor(member.user.createdAt.getTime() / 1000);
            const embed = new EmbedBuilder()
              .setTitle('🚨 Verdächtiger Account-Beitritt')
              .setColor(0xe67e22)
              .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
              .addFields(
                { name: '👤 User', value: `<@${member.user.id}> (${member.user.tag})`, inline: false },
                { name: '📅 Registriert vor', value: formatDuration(ageMs), inline: true },
                { name: '⏳ Registrierungsdatum', value: `<t:${createdSec}:F> (<t:${createdSec}:R>)`, inline: false }
              )
              .setFooter({ text: '🐾 Oreo • Kontoalters-Warnung' })
              .setTimestamp();

            await logChannel.send({ embeds: [embed] }).catch(() => null);
          }
        }
      }
    }
  } catch (err) {
    console.error('[account-age-check] failed to check account age:', err);
  }

  try {
    const captchaEnabled = (await config.getCaptchaEnabled(guildId)) || isRaidActive;
    if (captchaEnabled) {
      const captchaChannelId = await config.getCaptchaChannelId(guildId);
      const everyone = member.guild.roles.everyone;
      const botId = member.client.user.id;

      let verifyChannel = null;

      if (captchaChannelId) {
        verifyChannel = await member.guild.channels.fetch(captchaChannelId).catch(() => null);
        if (verifyChannel) {
          // Welcome member in DMs and point to verify channel
          await member.send({
            content: `Willkommen auf **${member.guild.name}**! Bitte verifiziere dich im kanal <#${captchaChannelId}>, um vollen Zugriff auf den Server zu erhalten.`
          }).catch(() => {});
        }
      }

      const isGlobal = !!verifyChannel;

      if (!isGlobal) {
        verifyChannel = await member.guild.channels.create({
          name: `verify-${member.user.id}`,
          type: 0,
          permissionOverwrites: [
            {
              id: everyone.id,
              deny: ['ViewChannel'],
            },
            {
              id: member.id,
              allow: ['ViewChannel', 'ReadMessageHistory'],
              deny: ['SendMessages', 'AddReactions'],
            },
            {
              id: botId,
              allow: ['ViewChannel', 'SendMessages', 'ManageChannels', 'ManageRoles', 'ReadMessageHistory'],
            }
          ],
          reason: 'Oreo Captcha-Verifizierung Setup',
        });

        const descriptionText = isRaidActive
          ? `⚠️ **SICHERHEITS-PANIKMODUS AKTIV!**\n\nAufgrund von verdächtigen Beitrittswellen wurde für **${member.guild.name}** die Captcha-Verifizierung temporär für alle neuen User aktiviert.\n\nBitte klicke auf den Button unten, um dich zu verifizieren!`
          : `Willkommen auf **${member.guild.name}**, <@${member.user.id}>!\n\nUm den Server freizuschalten, musst du dich verifizieren.\n\nKlicke auf den Button unten, um das Captcha zu starten.`;

        const embed = new EmbedBuilder()
          .setTitle('🔐 Server-Verifizierung')
          .setColor(0x3498db)
          .setDescription(descriptionText)
          .setFooter({ text: '🐾 Oreo • Verifizierung' })
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`captcha_start_${member.id}`)
            .setLabel('Verifizierung starten')
            .setStyle(ButtonStyle.Primary)
        );

        await verifyChannel.send({
          content: `<@${member.id}>`,
          embeds: [embed],
          components: [row]
        });
      }

      setTimeout(async () => {
        const currentMember = await member.guild.members.fetch(member.id).catch(() => null);
        if (currentMember) {
          const verifiedRoleId = await config.getVerifiedRoleId(guildId);
          const hasRole = verifiedRoleId ? currentMember.roles.cache.has(verifiedRoleId) : false;
          if (!hasRole) {
            await currentMember.kick('Oreo: Verifizierung abgelaufen').catch(() => null);
            const logChannelId = await config.getModLogChannelId(guildId);
            if (logChannelId) {
              const logChannel = await member.guild.channels.fetch(logChannelId).catch(() => null);
              if (logChannel) {
                const logEmbed = new EmbedBuilder()
                  .setTitle('❌ Verifizierung abgelaufen')
                  .setColor(0xe74c3c)
                  .setDescription(`Die Verifizierungszeit für <@${member.user.id}> (${member.user.tag}) ist abgelaufen. Der User wurde gekickt.`)
                  .setTimestamp();
                await logChannel.send({ embeds: [logEmbed] }).catch(() => null);
              }
            }
          }
        }
        if (!isGlobal && verifyChannel) {
          const chan = await member.guild.channels.fetch(verifyChannel.id).catch(() => null);
          if (chan) {
            await chan.delete('Oreo: Verifizierung abgelaufen').catch(() => null);
          }
        }
      }, 15 * 60 * 1000);
    }
  } catch (err) {
    console.error('[captcha-verification] failed to initiate verification channel:', err);
  }

  // Server-Log: Join
  try {
    const isJoinLeaveEnabled = await config.isLogJoinLeaveEnabled(guildId);
    if (isJoinLeaveEnabled) {
      const serverLogChannelId = await config.getServerLogChannelId(guildId);
      if (serverLogChannelId) {
        const logChannel = await member.guild.channels.fetch(serverLogChannelId).catch(() => null);
        if (logChannel) {
          const createdSec = Math.floor(member.user.createdAt.getTime() / 1000);
          const embed = new EmbedBuilder()
            .setTitle('📥 Member beigetreten')
            .setColor(0x2ecc71)
            .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
            .addFields(
              { name: '👤 User', value: `<@${member.user.id}> (${member.user.tag})`, inline: true },
              { name: '🆔 User-ID', value: member.user.id, inline: true },
              { name: '⏳ Registriert am', value: `<t:${createdSec}:F> (<t:${createdSec}:R>)`, inline: false }
            )
            .setTimestamp();
          await logChannel.send({ embeds: [embed] }).catch(() => null);
        }
      }
    }
  } catch (err) {
    console.error('[join-log] failed to log member join:', err);
  }

  // Server-Log: Invite Tracking
  try {
    const isInviteEnabled = await config.isLogInviteEnabled(guildId);
    if (isInviteEnabled) {
      const serverLogChannelId = await config.getServerLogChannelId(guildId);
      if (serverLogChannelId) {
        const logChannel = await member.guild.channels.fetch(serverLogChannelId).catch(() => null);
        if (logChannel) {
          const invitesTracker = require('../invites');
          const usedInvite = await invitesTracker.findUsedInvite(member.guild);
          
          let inviteInfo = 'Unbekannt (z.B. per Vanity-URL oder Bot-Invite)';
          if (usedInvite) {
            inviteInfo = `Code: \`${usedInvite.code}\` (Erstellt von <@${usedInvite.inviterId}>, Verwendungen: **${usedInvite.uses}**)`;
          }
          
          const embed = new EmbedBuilder()
            .setTitle('🎫 Einladungs-Tracking')
            .setColor(0xe91e63)
            .addFields(
              { name: '👤 User', value: `<@${member.user.id}> (${member.user.tag})`, inline: true },
              { name: '🆔 User-ID', value: member.user.id, inline: true },
              { name: '🔗 Einladung verwendet', value: inviteInfo, inline: false }
            )
            .setTimestamp();
          await logChannel.send({ embeds: [embed] }).catch(() => null);
        }
      }
    }
  } catch (err) {
    console.error('[invite-log] failed to track member join invite:', err);
  }

  // Welcome Card system
  try {
    const isWelcomeOn = await config.isWelcomeEnabled(guildId);
    if (isWelcomeOn) {
      const welcomeChannelId = await config.getWelcomeChannelId(guildId);
      if (welcomeChannelId) {
        const welcomeChannel = await member.guild.channels.fetch(welcomeChannelId).catch(() => null);
        if (welcomeChannel) {
          const welcomeMessageTemplate = await config.getWelcomeMessage(guildId);
          const bgUrl = await config.getWelcomeBgUrl(guildId);

          const { generateCard, formatWelcomeMessage } = require('../welcomeCard');
          const cardBuffer = await generateCard(member.user, member.guild, 'welcome', bgUrl);

          const { AttachmentBuilder } = require('discord.js');
          const attachment = new AttachmentBuilder(cardBuffer, { name: 'welcome.png' });
          const messageText = formatWelcomeMessage(welcomeMessageTemplate, member);

          await welcomeChannel.send({ content: messageText, files: [attachment] });
        }
      }
    }
  } catch (err) {
    console.error('[welcome-system] failed to send welcome card:', err);
  }
}

module.exports = {
  name: Events.GuildMemberAdd,
  execute,
};

