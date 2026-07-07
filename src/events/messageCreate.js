const { Events, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const cases = require('../cases');
const { buildModLogEmbed, buildAutoModHitEmbed } = require('../modlog');
const escalations = require('../escalations');
const obfuscation = require('../obfuscation');
const { getOrCreateMutedRole } = require('../composables/mutedRole');

// In-memory message history for channel-hopping detection.
// Keyed by `${guildId}:${userId}` (NOT bare userId) — a bare-userId key would let a user's
// activity in unrelated guilds count toward the same hopping window and trigger a false
// cross-guild 24h timeout.
const channelHoppingHistory = new Map();
const HOPPING_TIMEFRAME_MS = 10 * 1000; // 10 seconds
const HOPPING_UNIQUE_CHANNELS_LIMIT = 3; // 3 unique channels
const HOPPING_SWEEP_INTERVAL_MS = 60 * 1000; // periodic cleanup interval

const AUTOMOD_CONTENT_LIMIT = 500;
const AUTOMOD_MATCHED_LIMIT = 100;

function truncateForLog(str, max) {
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

// Evicts stale per-user histories even for users who hop once and then go quiet — otherwise
// their entry would live in the map forever and it would grow unboundedly.
function pruneHoppingHistory(now) {
  const cutoff = now - HOPPING_TIMEFRAME_MS;
  for (const [key, history] of channelHoppingHistory) {
    const fresh = history.filter((h) => h.timestamp >= cutoff);
    if (fresh.length === 0) {
      channelHoppingHistory.delete(key);
    } else if (fresh.length !== history.length) {
      channelHoppingHistory.set(key, fresh);
    }
  }
}

const hoppingSweepInterval = setInterval(() => pruneHoppingHistory(Date.now()), HOPPING_SWEEP_INTERVAL_MS);
hoppingSweepInterval.unref?.();

/**
 * Posts a plain-text warning to the guild's mod-log channel (best-effort, fail-soft).
 * Used when an automatic punishment attempt fails so moderators notice instead of the
 * failure silently disappearing.
 */
async function postModLogWarning(guild, text) {
  try {
    const modLogChannelId = await config.getModLogChannelId(guild.id);
    if (!modLogChannelId) return;
    const logChannel = await guild.channels.fetch(modLogChannelId).catch(() => null);
    if (logChannel) {
      await logChannel.send({ content: text }).catch(() => null);
    }
  } catch (err) {
    console.warn('[messageCreate] failed to post warning to modlog:', err);
  }
}

async function checkChannelHopping(message, member) {
  const guildId = message.guild.id;
  const userId = message.author.id;
  const key = `${guildId}:${userId}`;
  const now = Date.now();

  let history = channelHoppingHistory.get(key) ?? [];

  // Record current message as a minimal entry — never store the full Message object here,
  // that would pin the whole guild/channel/author object graph in memory for the window.
  history.push({
    timestamp: now,
    channelId: message.channel.id,
    messageId: message.id,
  });

  // Prune history older than the timeframe.
  const cutoff = now - HOPPING_TIMEFRAME_MS;
  history = history.filter((h) => h.timestamp >= cutoff);
  if (history.length === 0) {
    channelHoppingHistory.delete(key);
  } else {
    channelHoppingHistory.set(key, history);
  }

  // Check unique channels
  const uniqueChannels = new Set(history.map((h) => h.channelId));
  if (uniqueChannels.size >= HOPPING_UNIQUE_CHANNELS_LIMIT) {
    const durationMs = 24 * 60 * 60 * 1000; // 24 hours
    let caseNumber = null;
    const reason = 'Channel-Hopping Spam-Erkennung (Automatischer Timeout)';
    const pendingDeletions = history;

    // Clear user history up front so this window can't re-trigger on the next message,
    // regardless of whether the timeout below actually succeeds.
    channelHoppingHistory.delete(key);

    // 1. Timeout user. No phantom punishment: if this throws, stop here — do NOT delete
    // messages, do NOT createCase, do NOT post the success modlog. Just warn moderators.
    try {
      await member.timeout(durationMs, `Oreo AutoMod: ${reason}`);
    } catch (err) {
      console.error('[channel-hopping] failed to timeout member:', err);
      await postModLogWarning(
        message.guild,
        `⚠️ Auto-Timeout gegen <@${userId}> (Channel-Hopping) fehlgeschlagen — vermutlich fehlende Berechtigung (Rolle des Users über dem Bot?). Fehler: ${err.message}`
      );
      return true; // still spam — punishment just failed, don't fall through to toxicity checks
    }

    // 2. Delete messages in history, resolved via the stored ids (works even if the
    // original Message objects were never cached / are gone by now).
    for (const item of pendingDeletions) {
      const channel = await message.client.channels.fetch(item.channelId).catch(() => null);
      if (channel) {
        await channel.messages.delete(item.messageId).catch(() => null);
      }
    }

    // 3. Create case in DB
    try {
      const result = await cases.createCase({
        guildId,
        userId: userId,
        moderatorId: message.client.user.id,
        type: 'timeout',
        reason,
        source: 'automod',
        durationMs: BigInt(durationMs),
        expiresInMs: durationMs,
      });
      caseNumber = result?.caseNumber;
    } catch (err) {
      console.error('[channel-hopping] createCase failed:', err);
    }

    // 4. Send embed to ModLog channel
    try {
      const modLogChannelId = await config.getModLogChannelId(guildId);
      if (modLogChannelId) {
        const logChannel = await message.guild.channels.fetch(modLogChannelId).catch(() => null);
        if (logChannel) {
          const embed = buildModLogEmbed({
            action: 'timeout',
            caseNumber,
            target: message.author,
            mod: message.client.user,
            reason,
            durationMs,
          });
          if (embed) {
            await logChannel.send({ embeds: [embed] }).catch(() => null);
          }
        }
      }
    } catch (logErr) {
      console.warn('[channel-hopping] failed to log to modlog:', logErr);
    }

    return true; // Spam action taken
  }

  return false;
}

async function execute(message) {
  if (message.author.bot || !message.guild) return;

  const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;

  if (member.permissions.has(PermissionFlagsBits.ManageMessages) || member.permissions.has(PermissionFlagsBits.Administrator)) {
    return;
  }

  // --- Channel-Hopping Anti-Spam Check ---
  try {
    const isSpam = await checkChannelHopping(message, member);
    if (isSpam) return; // Stop processing further features for this message (already deleted/timed out)
  } catch (err) {
    console.error('[messageCreate] Channel-hopping check failed:', err);
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
      // Set when the actual punishment failed — suppresses the success modlog/case so we
      // never claim a punishment happened when it didn't (no phantom records).
      let skipSuccessLog = false;

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
        const role = await getOrCreateMutedRole(message.guild).catch((err) => {
          console.error('[messageCreate] getOrCreateMutedRole failed:', err);
          return null;
        });

        if (!role) {
          skipSuccessLog = true;
          console.error('[messageCreate] no Muted role available — skipping mute punishment');
          await postModLogWarning(
            message.guild,
            `⚠️ Auto-Mute gegen <@${message.author.id}> (Toxizitäts-Filter) fehlgeschlagen — vermutlich fehlende Berechtigung (Rolle des Users über dem Bot?). Fehler: Muted-Rolle konnte nicht ermittelt/erstellt werden.`
          );
        } else {
          try {
            await member.roles.add(role, 'Oreo: Toxizitäts-Filter Verstoß');
          } catch (err) {
            skipSuccessLog = true;
            console.error('[messageCreate] failed to assign Muted role:', err);
            await postModLogWarning(
              message.guild,
              `⚠️ Auto-Mute gegen <@${message.author.id}> (Toxizitäts-Filter) fehlgeschlagen — vermutlich fehlende Berechtigung (Rolle des Users über dem Bot?). Fehler: ${err.message}`
            );
          }
        }

        if (!skipSuccessLog) {
          await cases.deactivateActiveInfractions(guildId, message.author.id, 'mute').catch(() => null);

          const durationMs = 10 * 60 * 1000;

          const result = await cases.createCase({
            guildId,
            userId: message.author.id,
            moderatorId: message.client.user.id,
            type: 'mute',
            reason,
            source: 'automod',
            durationMs: BigInt(durationMs),
            expiresInMs: durationMs,
          }).catch((err) => {
            console.error('[messageCreate] createCase mute failed:', err);
            return null;
          });
          caseNumber = result?.caseNumber;
        }

      } else {
        // action === 'delete': the message was already removed above; just persist
        // the case and log the automod hit.
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

      if (!skipSuccessLog) {
        try {
          const modLogChannelId = await config.getModLogChannelId(guildId);
          if (modLogChannelId) {
            const logChannel = await message.guild.channels.fetch(modLogChannelId).catch(() => null);
            if (logChannel) {
              let embed;
              if (action === 'delete') {
                // buildModLogEmbed has no 'automod_hit' branch and returns null (silently
                // dropping the log) — use the dedicated automod-hit embed instead.
                embed = buildAutoModHitEmbed({
                  caseNumber: caseNumber ?? '?',
                  filterKey: 'custom_wordlist',
                  userId: message.author.id,
                  username: message.author.globalName ?? message.author.username ?? null,
                  channelId: message.channel.id,
                  content: truncateForLog(message.content, AUTOMOD_CONTENT_LIMIT),
                  matched: truncateForLog(matchedWord, AUTOMOD_MATCHED_LIMIT),
                  ruleId: null,
                });
              } else {
                embed = buildModLogEmbed({
                  action,
                  caseNumber,
                  target: message.author,
                  mod: message.client.user,
                  reason,
                  durationMs: action === 'mute' ? 10 * 60 * 1000 : null,
                });
              }
              if (embed) {
                await logChannel.send({ embeds: [embed] }).catch(() => null);
              }
            }
          }
        } catch (logErr) {
          console.warn('[messageCreate] failed to log to modlog:', logErr);
        }
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
