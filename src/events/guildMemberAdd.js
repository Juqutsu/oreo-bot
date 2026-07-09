const { Events, EmbedBuilder } = require('discord.js');
const config = require('../config');
const cases = require('../cases');
const verifications = require('../verifications');
const { getMutedRole } = require('../composables/mutedRole');
const { getOrCreateSharedVerifyChannel } = require('../composables/verifyChannel');
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
    const joinRoleIds = await config.getJoinRoleIds(guildId);
    for (const rId of joinRoleIds) {
      const role = member.guild.roles.cache.get(rId) || await member.guild.roles.fetch(rId).catch(() => null);
      if (role) {
        await member.roles.add(role, 'Oreo: Join-Rolle automatisch zugewiesen');
      }
    }
  } catch (roleErr) {
    console.error('[join-role] failed to assign join roles on join:', roleErr);
  }

  try {
    const captchaEnabled = (await config.getCaptchaEnabled(guildId)) || isRaidActive;
    if (captchaEnabled) {
      // Ein geteilter Verifizierungs-Kanal für alle statt eines Kanals pro Joiner —
      // pro-User-Kanäle haben eine Raid-Welle in ein Rate-Limit-DoS verwandelt
      // (N Joins = N Channel-Erstellungen). Erstellung ist pro Guild dedupliziert,
      // siehe getOrCreateSharedVerifyChannel.
      const verifyChannel = await getOrCreateSharedVerifyChannel(member.guild);
      await member.send({
        content: `Willkommen auf **${member.guild.name}**! Bitte verifiziere dich in <#${verifyChannel.id}>, um vollen Zugriff zu erhalten.`,
      }).catch(() => {});

      // Restart-sicher: Deadline in DB, Sweep läuft im Background-Loop.
      // channelId ist immer null: der geteilte Kanal darf vom Sweep nie gelöscht werden.
      await verifications.trackJoin(guildId, member.id, null, 15);
    }
  } catch (err) {
    console.error('[captcha-verification] failed to initiate verification channel:', err);
  }

  // Mute-Rejoin-Enforcement: aktive Mute-Rolle nach erneutem Beitritt wiederherstellen
  try {
    // Real GuildMembers always have `.id`; only mocks/partials in tests may lack it.
    // Skip silently in that case instead of passing `undefined` into the DB query.
    const memberId = member.id ?? member.user?.id;
    if (memberId) {
      const hasActiveMute = await cases.hasActiveInfraction(guildId, memberId, 'mute');
      if (hasActiveMute) {
        const mutedRole = await getMutedRole(member.guild);
        if (mutedRole) {
          const reapplied = await member.roles.add(mutedRole, 'Oreo: Aktiver Mute — Rolle nach Rejoin wieder angewendet').then(() => true).catch((err) => {
            console.error('[guildMemberAdd] Re-applying muted role failed:', err);
            return false;
          });

          const logChannelId = await config.getModLogChannelId(guildId);
          if (logChannelId) {
            const logChannel = await member.guild.channels.fetch(logChannelId).catch(() => null);
            if (logChannel) {
              if (reapplied) {
                await logChannel.send(`🔇 <@${memberId}> ist mit aktivem Mute erneut beigetreten — Muted-Rolle wieder angewendet.`).catch(() => null);
              } else {
                await logChannel.send(`⚠️ <@${memberId}> ist mit aktivem Mute erneut beigetreten, aber die Muted-Rolle konnte NICHT wieder angewendet werden — prüfe Bot-Berechtigungen/Rollen-Hierarchie.`).catch(() => null);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[mute-rejoin] failed to re-apply muted role on rejoin:', err);
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
          const bannerEnabled = await config.isWelcomeBannerEnabled(guildId);

          // Single member fetch shared by the message text and the card image
          // (previously each fetched the full member list separately).
          let memberCount = member.guild.memberCount;
          try {
            const members = await member.guild.members.fetch();
            memberCount = members.filter((m) => !m.user.bot).size;
          } catch (err) {
            console.warn('[welcome-system] failed to fetch guild members, falling back to total memberCount:', err.message);
          }

          const { formatWelcomeMessage } = require('../welcomeCard');
          const messageText = await formatWelcomeMessage(welcomeMessageTemplate, member, memberCount);

          const sendPayload = { content: messageText };

          if (bannerEnabled) {
            const { generateCard } = require('../welcomeCard');
            const cardBuffer = await generateCard(member.user, member.guild, 'welcome', bgUrl, memberCount);
            const { AttachmentBuilder } = require('discord.js');
            const attachment = new AttachmentBuilder(cardBuffer, { name: 'welcome.png' });
            sendPayload.files = [attachment];
          }

          await welcomeChannel.send(sendPayload);
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

