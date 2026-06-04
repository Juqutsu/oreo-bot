const { Events, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const cases = require('../cases');
const { buildModLogEmbed } = require('../modlog');
const escalations = require('../escalations');
const obfuscation = require('../obfuscation');
const { getOrCreateMutedRole } = require('../composables/mutedRole');

async function execute(message) {
  if (message.author.bot || !message.guild) return;

  const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;

  if (member.permissions.has(PermissionFlagsBits.ManageMessages) || member.permissions.has(PermissionFlagsBits.Administrator)) {
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
      await message.delete().catch(() => null);

      const warningMsg = await message.channel.send(`❌ <@${message.author.id}>, deine Nachricht wurde gelöscht, da sie blockierte Wörter enthält.`).catch(() => null);
      if (warningMsg) {
        setTimeout(() => warningMsg.delete().catch(() => null), 5000);
      }

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

        try {
          const activeWarnCount = await cases.countActiveWarnings(guildId, message.author.id);
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
          await member.roles.add(role, 'Oreo: Toxizitäts-Filter Verstoß').catch((err) => {
            console.error('[messageCreate] failed to assign Muted role:', err);
          });
        }

        await cases.deactivateActiveInfractions(guildId, message.author.id, 'mute').catch(() => null);

        const durationMs = 10 * 60 * 1000;
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
