const { Events } = require('discord.js');

const automod = require('../automod');
const cases   = require('../cases');
const modlog  = require('../modlog');
const config  = require('../config');

const TRUNC_CONTENT = 500;
const TRUNC_MATCHED = 100;
const TRUNC_REASON  = 480; // leaves headroom under the 512-char DB column

function truncate(str, max) {
  if (str == null) return '';
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function buildReason(filterKey, matched, channelMention) {
  const raw = `[AutoMod: ${filterKey}] match="${truncate(matched, TRUNC_MATCHED)}" in ${channelMention}`;
  return truncate(raw, TRUNC_REASON);
}

async function execute(execution) {
  // 1. Owned-rule filter.
  let filterKey;
  try {
    filterKey = await automod.getFilterKeyByRuleId(execution.guild.id, execution.ruleId);
  } catch (err) {
    console.error('[automod] getFilterKeyByRuleId failed:', err);
    return;
  }
  if (!filterKey) return; // not our rule

  const matchedRaw  = execution.matchedContent ?? execution.matchedKeyword ?? '—';
  const channelMention = execution.channelId ? `<#${execution.channelId}>` : 'unknown-channel';

  // 2. Persist case (fail-soft).
  let caseNumber = null;
  try {
    const result = await cases.createCase({
      guildId:     execution.guild.id,
      userId:      execution.userId,
      moderatorId: execution.guild.client.user.id,
      type:        'automod_hit',
      source:      'automod',
      reason:      buildReason(filterKey, matchedRaw, channelMention),
      active:      0,
    });
    caseNumber = result.caseNumber;
  } catch (err) {
    console.error('[automod] failed to persist case:', err);
  }

  // 3. Post mod-log (fail-soft).
  try {
    const modLogChannelId = await config.getModLogChannelId(execution.guild.id);
    if (!modLogChannelId) return;

    const channel = await execution.guild.channels.fetch(modLogChannelId).catch(() => null);
    if (!channel) return;

    let username = null;
    try {
      const user = await execution.guild.client.users.fetch(execution.userId);
      username = user?.globalName ?? user?.username ?? null;
    } catch { /* unknown user — fall through */ }

    const embed = modlog.buildAutoModHitEmbed({
      caseNumber: caseNumber ?? '?',
      filterKey,
      userId:     execution.userId,
      username,
      channelId:  execution.channelId,
      content:    truncate(execution.content ?? '', TRUNC_CONTENT),
      matched:    truncate(matchedRaw, TRUNC_MATCHED),
      ruleId:     execution.ruleId,
    });
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[automod] failed to post mod-log:', err);
  }
}

module.exports = {
  name: Events.AutoModerationActionExecution,
  execute,
};
