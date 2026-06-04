const {
  AutoModerationRuleEventType,
  AutoModerationActionType,
  AutoModerationRuleTriggerType,
  AutoModerationRuleKeywordPresetType,
} = require('discord.js');

const { getPool } = require('./db');

// ---- Constants ----

const FILTER_KEYS = Object.freeze([
  'spam',
  'mention_spam',
  'invite_links',
  'keyword_preset',
  'custom_wordlist',
]);

// Rust-flavoured regex (Discord's AutoMod engine uses Rust regex).
// All patterns are kept under 30 chars to stay well within Discord's 260-char-per-pattern limit.
const INVITE_REGEX = Object.freeze([
  String.raw`discord\.gg/[\w-]+`,
  String.raw`discord(?:app)?\.com/invite/[\w-]+`,
  String.raw`dsc\.gg/[\w-]+`,
  String.raw`invite\.gg/[\w-]+`,
]);

const PRESET_BITS = Object.freeze({
  profanity:      0b001,
  sexual_content: 0b010,
  slurs:          0b100,
});
const PRESET_FLAGS_ALL = 0b111;

const MENTION_THRESHOLD_DEFAULT = 5;

const LIMIT_EXEMPT_ROLES    = 20;
const LIMIT_EXEMPT_CHANNELS = 50;
const LIMIT_WORDLIST_TOTAL  = 1000;
const LIMIT_WORD_LENGTH     = 60;

// ---- Error type ----

class AutoModError extends Error {
  constructor(code, detail = null) {
    super(`AutoModError: ${code}${detail !== null ? ` (${detail})` : ''}`);
    this.code = code;
    this.detail = detail;
  }
}

// ---- DAL: automod_rules ----

async function getRuleState(guildId, filterKey) {
  const [rows] = await getPool().execute(
    `SELECT filter_key, discord_rule_id, enabled, threshold, preset_flags
       FROM automod_rules WHERE guild_id = ? AND filter_key = ?`,
    [guildId, filterKey],
  );
  return rows[0] ?? null;
}

async function getAllRuleStates(guildId) {
  const [rows] = await getPool().execute(
    `SELECT filter_key, discord_rule_id, enabled, threshold, preset_flags
       FROM automod_rules WHERE guild_id = ? ORDER BY filter_key`,
    [guildId],
  );
  return rows;
}

async function upsertRuleState(guildId, filterKey, fields) {
  // Guild row must exist first (FK constraint).
  await getPool().execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [guildId]);

  const allowed = ['discord_rule_id', 'enabled', 'threshold', 'preset_flags'];
  const cols = allowed.filter((c) => Object.prototype.hasOwnProperty.call(fields, c));
  if (cols.length === 0) return;

  const insertCols = ['guild_id', 'filter_key', ...cols].join(', ');
  const placeholders = ['?', '?', ...cols.map(() => '?')].join(', ');
  const updates = cols.map((c) => `${c} = VALUES(${c})`).join(', ');
  const values = [guildId, filterKey, ...cols.map((c) => fields[c])];

  await getPool().execute(
    `INSERT INTO automod_rules (${insertCols}) VALUES (${placeholders})
     ON DUPLICATE KEY UPDATE ${updates}`,
    values,
  );
}

async function getFilterKeyByRuleId(guildId, discordRuleId) {
  const [rows] = await getPool().execute(
    `SELECT filter_key FROM automod_rules
      WHERE guild_id = ? AND discord_rule_id = ?`,
    [guildId, discordRuleId],
  );
  return rows[0]?.filter_key ?? null;
}

async function getEnabledRuleIds(guildId) {
  const [rows] = await getPool().execute(
    `SELECT filter_key, discord_rule_id FROM automod_rules
      WHERE guild_id = ? AND enabled = 1 AND discord_rule_id IS NOT NULL`,
    [guildId],
  );
  return rows;
}

// ---- DAL: automod_wordlist ----

async function getWordlist(guildId) {
  const [rows] = await getPool().execute(
    `SELECT word FROM automod_wordlist WHERE guild_id = ? ORDER BY word`,
    [guildId],
  );
  return rows.map((r) => r.word);
}

async function countWords(guildId) {
  const [[row]] = await getPool().execute(
    `SELECT COUNT(*) AS n FROM automod_wordlist WHERE guild_id = ?`,
    [guildId],
  );
  return row.n;
}

async function addWord(guildId, word, addedBy) {
  const normalised = word.trim().toLowerCase();
  if (normalised.length === 0)                     throw new AutoModError('WORD_EMPTY');
  if (normalised.length > LIMIT_WORD_LENGTH)       throw new AutoModError('WORD_TOO_LONG', normalised.length);
  try {
    await getPool().execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [guildId]);
    // Atomic insert: the sub-select guard prevents going over LIMIT_WORDLIST_TOTAL even
    // under concurrent calls. MySQL evaluates the WHERE before constraint checks, so
    // affectedRows=0 means the cap was hit, while 1062 (caught below) means duplicate.
    const [result] = await getPool().execute(
      `INSERT INTO automod_wordlist (guild_id, word, added_by)
         SELECT ?, ?, ?
          WHERE (SELECT COUNT(*) FROM automod_wordlist WHERE guild_id = ?) < ?`,
      [guildId, normalised, addedBy, guildId, LIMIT_WORDLIST_TOTAL],
    );
    if (result.affectedRows === 0) {
      throw new AutoModError('WORDLIST_FULL', LIMIT_WORDLIST_TOTAL);
    }
  } catch (err) {
    if (err.errno === 1062) throw new AutoModError('WORD_DUPLICATE', normalised);
    throw err;
  }
  return normalised;
}

async function removeWord(guildId, word) {
  const normalised = word.trim().toLowerCase();
  const [result] = await getPool().execute(
    `DELETE FROM automod_wordlist WHERE guild_id = ? AND word = ?`,
    [guildId, normalised],
  );
  if (result.affectedRows === 0) throw new AutoModError('WORD_NOT_FOUND', normalised);
  return normalised;
}

// ---- DAL: automod_exemptions (reuses existing table from Stage 1) ----

async function getExtraExemptIds(guildId, targetType) {
  const [rows] = await getPool().execute(
    `SELECT target_id FROM automod_exemptions
      WHERE guild_id = ? AND target_type = ?`,
    [guildId, targetType],
  );
  return rows.map((r) => String(r.target_id));
}

async function addExemption(guildId, targetType, targetId) {
  await getPool().execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [guildId]);
  try {
    await getPool().execute(
      `INSERT INTO automod_exemptions (guild_id, target_type, target_id) VALUES (?, ?, ?)`,
      [guildId, targetType, targetId],
    );
  } catch (err) {
    if (err.errno === 1062) throw new AutoModError('EXEMPT_DUPLICATE', `${targetType}:${targetId}`);
    throw err;
  }
}

async function removeExemption(guildId, targetType, targetId) {
  const [result] = await getPool().execute(
    `DELETE FROM automod_exemptions WHERE guild_id = ? AND target_type = ? AND target_id = ?`,
    [guildId, targetType, targetId],
  );
  if (result.affectedRows === 0) throw new AutoModError('EXEMPT_NOT_FOUND', `${targetType}:${targetId}`);
}

// ---- Exempt-list union (admin+mod tier roles + extras), with hard-fail on limits ----

async function getTierRoleIds(guildId, tiers) {
  const placeholders = tiers.map(() => '?').join(', ');
  const [rows] = await getPool().execute(
    `SELECT role_id FROM role_permissions
      WHERE guild_id = ? AND permission IN (${placeholders})`,
    [guildId, ...tiers],
  );
  return rows.map((r) => String(r.role_id));
}

async function buildExempts(guildId) {
  const tierRoles  = await getTierRoleIds(guildId, ['owner', 'moderator']);
  const extraRoles = await getExtraExemptIds(guildId, 'role');
  const extraChans = await getExtraExemptIds(guildId, 'channel');

  const exemptRoles    = [...new Set([...tierRoles, ...extraRoles])];
  const exemptChannels = [...new Set(extraChans)];

  if (exemptRoles.length    > LIMIT_EXEMPT_ROLES)    throw new AutoModError('LIMIT_ROLES_20',    exemptRoles.length);
  if (exemptChannels.length > LIMIT_EXEMPT_CHANNELS) throw new AutoModError('LIMIT_CHANNELS_50', exemptChannels.length);

  return { exemptRoles, exemptChannels };
}

// ---- Preset bitmask helpers ----

function unpackPresets(flags) {
  const out = [];
  if (flags & PRESET_BITS.profanity)      out.push(AutoModerationRuleKeywordPresetType.Profanity);
  if (flags & PRESET_BITS.sexual_content) out.push(AutoModerationRuleKeywordPresetType.SexualContent);
  if (flags & PRESET_BITS.slurs)          out.push(AutoModerationRuleKeywordPresetType.Slurs);
  return out;
}

// ---- Filter trigger-metadata builders ----

const TRIGGER_NAMES = {
  spam:            'Spam Detection',
  mention_spam:    'Mass-Mention Protection',
  invite_links:    'Invite Link Filter',
  keyword_preset:  'Discord Preset Filter',
  custom_wordlist: 'Custom Wordlist',
};

async function buildTriggerMetadata(guildId, filterKey, state) {
  switch (filterKey) {
    case 'spam':
      return { triggerType: AutoModerationRuleTriggerType.Spam, triggerMetadata: {} };

    case 'mention_spam': {
      const threshold = state?.threshold ?? MENTION_THRESHOLD_DEFAULT;
      return {
        triggerType: AutoModerationRuleTriggerType.MentionSpam,
        triggerMetadata: {
          mentionTotalLimit: threshold,
          mentionRaidProtectionEnabled: true,
        },
      };
    }

    case 'invite_links':
      return {
        triggerType: AutoModerationRuleTriggerType.Keyword,
        triggerMetadata: {
          keywordFilter: [],
          regexPatterns: [...INVITE_REGEX],
          allowList:     [],
        },
      };

    case 'keyword_preset': {
      const flags = state?.preset_flags ?? PRESET_FLAGS_ALL;
      return {
        triggerType: AutoModerationRuleTriggerType.KeywordPreset,
        triggerMetadata: {
          presets:   unpackPresets(flags),
          allowList: [],
        },
      };
    }

    case 'custom_wordlist': {
      const words = await getWordlist(guildId);
      if (words.length === 0) throw new AutoModError('WORDLIST_EMPTY');
      return {
        triggerType: AutoModerationRuleTriggerType.Keyword,
        triggerMetadata: {
          keywordFilter: words,
          regexPatterns: [],
          allowList:     [],
        },
      };
    }

    default:
      throw new AutoModError('UNKNOWN_FILTER', filterKey);
  }
}

function buildBasePayload(name, exempts, moderatorTag) {
  return {
    name: `Oreo · ${name}`,
    eventType: AutoModerationRuleEventType.MessageSend,
    actions: [{
      type: AutoModerationActionType.BlockMessage,
      metadata: { customMessage: 'Blockiert von Oreo AutoMod.' },
    }],
    enabled: true,
    exemptRoles:    exempts.exemptRoles,
    exemptChannels: exempts.exemptChannels,
    reason: `Oreo /automod — provisioned by ${moderatorTag}`,
  };
}

// ---- REST wrappers ----

async function createDiscordRule(guild, filterKey, moderatorTag) {
  const state    = await getRuleState(guild.id, filterKey);
  const exempts  = await buildExempts(guild.id);
  const trigger  = await buildTriggerMetadata(guild.id, filterKey, state);
  const payload  = {
    ...buildBasePayload(TRIGGER_NAMES[filterKey], exempts, moderatorTag),
    ...trigger,
  };
  return guild.autoModerationRules.create(payload);
}

async function deleteDiscordRule(guild, ruleId, reason) {
  try {
    await guild.autoModerationRules.delete(ruleId, reason);
  } catch (err) {
    if (err.code === 10066) return; // 10066 = Unknown auto-moderation rule (already gone)
    throw err;
  }
}

async function patchDiscordRule(guild, ruleId, updates) {
  // Returns the patched AutoModerationRule, or null if Discord 404s.
  try {
    return await guild.autoModerationRules.edit(ruleId, updates);
  } catch (err) {
    if (err.code === 10066) return null;
    throw err;
  }
}

async function fetchDiscordRule(guild, ruleId) {
  try {
    return await guild.autoModerationRules.fetch(ruleId);
  } catch (err) {
    if (err.code === 10066) return null;
    throw err;
  }
}

// ---- Module exports ----

module.exports = {
  // Constants
  FILTER_KEYS,
  INVITE_REGEX,
  PRESET_BITS,
  PRESET_FLAGS_ALL,
  MENTION_THRESHOLD_DEFAULT,
  TRIGGER_NAMES,
  LIMIT_EXEMPT_ROLES,
  LIMIT_EXEMPT_CHANNELS,
  LIMIT_WORDLIST_TOTAL,
  LIMIT_WORD_LENGTH,
  AutoModError,
  // Rule state DAL
  getRuleState,
  getAllRuleStates,
  upsertRuleState,
  getFilterKeyByRuleId,
  getEnabledRuleIds,
  // Wordlist DAL
  getWordlist,
  countWords,
  addWord,
  removeWord,
  // Exemption DAL
  getExtraExemptIds,
  addExemption,
  removeExemption,
  // Helpers
  getTierRoleIds,
  buildExempts,
  unpackPresets,
  buildTriggerMetadata,
  buildBasePayload,
  // REST
  createDiscordRule,
  deleteDiscordRule,
  patchDiscordRule,
  fetchDiscordRule,
};
