const { Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const { formatDuration } = require('../duration');

async function execute(member) {
  if (member.user.bot) return;

  const guildId = member.guild.id;

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
    const captchaEnabled = await config.getCaptchaEnabled(guildId);
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
            content: `Willkommen auf **${member.guild.name}**! Bitte verifiziere dich im Kanal <#${captchaChannelId}>, um vollen Zugriff auf den Server zu erhalten.`
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

        const embed = new EmbedBuilder()
          .setTitle('🔐 Server-Verifizierung')
          .setColor(0x3498db)
          .setDescription(`Willkommen auf **${member.guild.name}**, <@${member.user.id}>!\n\nUm den Server freizuschalten, musst du dich verifizieren.\n\nKlicke auf den Button unten, um das Captcha zu starten.`)
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
}

module.exports = {
  name: Events.GuildMemberAdd,
  execute,
};
