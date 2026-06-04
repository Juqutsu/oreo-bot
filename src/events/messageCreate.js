const { Events, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const cases = require('../cases');
const { buildModLogEmbed } = require('../modlog');
const escalations = require('../escalations');
const obfuscation = require('../obfuscation');

async function getOrCreateMutedRole(guild) {
  const guildId = guild.id;
  let roleId = await config.getMutedRoleId(guildId);
  let role = null;

  if (roleId) {
    role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
  }

  if (!role) {
    role = guild.roles.cache.find((r) => r.name === 'Muted') || null;
    if (role) {
      await config.setMutedRoleId(guildId, role.id);
    }
  }

  if (!role) {
    role = await guild.roles.create({
      name: 'Muted',
      color: 0x818386,
      reason: 'Oreo Muted-Rolle Setup',
    }).catch((err) => {
      console.error('[messageCreate] Konnte Muted-Rolle nicht erstellen:', err);
      return null;
    });

    if (role) {
      await config.setMutedRoleId(guildId, role.id);

      // Edit channel overwrites (best-effort)
      const channels = await guild.channels.fetch().catch(() => new Map());
      for (const [_, channel] of channels) {
        if (channel.isTextBased() || channel.isVoiceBased()) {
          await channel.permissionOverwrites.create(role, {
            SendMessages: false,
            AddReactions: false,
            Speak: false,
          }, { reason: 'Oreo Muted-Rolle Setup' }).catch(() => null);
        }
      }
    }
  }

  return role;
}

async function execute(message) {
  // Ignore bots and DMs
  if (message.author.bot || !message.guild) return;

  // Exempt administrators and moderators with ManageMessages permission
  if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages) || message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    return;
  }

  const guildId = message.guild.id;

  try {
    const enabled = await config.getToxicityEnabled(guildId);
    if (!enabled) return;

    const badWords = await config.getBadWords(guildId);
    if (badWords.length === 0) return;

    const normalizedContent = obfuscation.normalize(message.content);
    let matchedWord = null;

    for (const word of badWords) {
      const normalizedWord = obfuscation.normalize(word);
      if (normalizedWord && normalizedContent.includes(normalizedWord)) {
        matchedWord = word;
        break;
      }
    }

    if (matchedWord) {
      // 1. Delete message
      await message.delete().catch(() => null);

      // 2. Ephemeral warning message (deleted after 5 seconds)
      const warningMsg = await message.channel.send(`❌ <@${message.author.id}>, deine Nachricht wurde gelöscht, da sie blockierte Wörter enthält.`).catch(() => null);
      if (warningMsg) {
        setTimeout(() => warningMsg.delete().catch(() => null), 5000);
      }

      // 3. Process action
      const action = await config.getToxicityAction(guildId);
      let caseNumber = null;
      let reason = `Toxizitäts-Filter: Blockiertes Wort "${matchedWord}"`;

      if (action === 'warn') {
        const result = await cases.createCase({
          guildId,
          userId: message.author.id,
          moderatorId: message.client.user.id,
          type: 'warn',
          reason,
          source: 'automod',
        }).catch((err) => {
          console.error('[messageCreate] createCase warn failed:', err);
          return null;
        });
        caseNumber = result?.caseNumber;

        // Apply escalation rules
        try {
          const activeWarnCount = await cases.countActiveWarnings(guildId, message.author.id);
          // Construct a mock interaction so applyEscalation doesn't crash on replies
          let followUpMsg = null;
          const mockInteraction = {
            guildId,
            guild: message.guild,
            client: message.client,
            member: message.guild.members.me,
            user: message.client.user,
            reply: async () => {},
            followUp: async (payload) => {
              followUpMsg = payload.content;
            }
          };
          await escalations.applyEscalation({
            interaction: mockInteraction,
            target: message.author,
            activeWarnCount
          });
        } catch (escErr) {
          console.warn('[messageCreate] auto-escalation failed:', escErr);
        }

      } else if (action === 'mute') {
        const role = await getOrCreateMutedRole(message.guild);
        if (role) {
          await message.member.roles.add(role, 'Oreo: Toxizitäts-Filter Verstoß').catch((err) => {
            console.error('[messageCreate] failed to assign Muted role:', err);
          });
        }

        // Deactivate previous active mutes
        await cases.deactivateActiveInfractions(guildId, message.author.id, 'mute').catch(() => null);

        const durationMs = 10 * 60 * 1000; // 10 minutes default temp-mute
        const expiresAt = new Date(Date.now() + durationMs);

        const result = await cases.createCase({
          guildId,
          userId: message.author.id,
          moderatorId: message.client.user.id,
          type: 'mute',
          reason,
          source: 'automod',
          durationMs: BigInt(durationMs),
          expiresAt,
        }).catch((err) => {
          console.error('[messageCreate] createCase mute failed:', err);
          return null;
        });
        caseNumber = result?.caseNumber;

      } else {
        // action === 'delete'
        const result = await cases.createCase({
          guildId,
          userId: message.author.id,
          moderatorId: message.client.user.id,
          type: 'automod_hit',
          reason,
          source: 'automod',
        }).catch((err) => {
          console.error('[messageCreate] createCase delete failed:', err);
          return null;
        });
        caseNumber = result?.caseNumber;
      }

      // 4. Log to Modlog
      try {
        const modLogChannelId = await config.getModLogChannelId(guildId);
        if (modLogChannelId) {
          const logChannel = await message.guild.channels.fetch(modLogChannelId).catch(() => null);
          if (logChannel) {
            const embed = buildModLogEmbed({
              action: action === 'delete' ? 'automod_hit' : action,
              caseNumber,
              target: message.author,
              mod: message.client.user,
              reason,
              durationMs: action === 'mute' ? 10 * 60 * 1000 : null,
            });
            if (embed) {
              await logChannel.send({ embeds: [embed] }).catch(() => null);
            }
          }
        }
      } catch (logErr) {
        console.warn('[messageCreate] failed to log to modlog:', logErr);
      }
    }
  } catch (err) {
    console.error('[messageCreate] Toxicity filter execution failed:', err);
  }
}

module.exports = {
  name: Events.MessageCreate,
  execute,
};
