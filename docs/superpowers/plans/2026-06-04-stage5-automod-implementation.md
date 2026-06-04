# Stage 5 — AutoMod Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship native Discord AutoMod for the Oreo bot — five filters (spam, mention_spam, invite_links, keyword_preset, custom_wordlist), passive `automod_hit` cases, `/automod` admin command, all via Discord's server-side `AutoModerationRule` API (no privileged intent).

**Architecture:** Bot provisions Discord `AutoModerationRule` objects via REST. Discord enforces server-side and fires `AutoModerationActionExecution` events for hits we own. Event handler creates `type='automod_hit', active=0` cases (decoupled from Stage-3 escalation) and posts an orange mod-log embed. Admin config via `/automod` slash command. New `src/events/` infrastructure with a tiny `loadEvents.js` auto-discoverer establishes the pattern for Stage-6+ event handlers.

**Tech Stack:** Node.js 20.6+, discord.js v14.26, mysql2, Docker Compose. No test runner — verification is smoke-loads + manual Discord E2E.

**Spec:** [docs/superpowers/specs/2026-06-04-stage5-automod-design.md](../specs/2026-06-04-stage5-automod-design.md)

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| [server/schema.sql](../../server/schema.sql) | modify | Append: 1 ALTER on `infractions.type`, 2 new CREATE TABLE. |
| [src/cases.js](../../src/cases.js) | modify | Add optional `active` parameter to `createCase()` (default `1`, unchanged for all existing callers). |
| [src/automod.js](../../src/automod.js) | **create** | DAL for `automod_rules` / `automod_wordlist` / `automod_exemptions` reads-writes, exempt union helper, filter-builder lookup map, REST wrappers, constants (`INVITE_REGEX`, `PRESET_BITS`, `FILTER_KEYS`), `AutoModError` class. |
| [src/modlog.js](../../src/modlog.js) | modify | Add `buildAutoModHitEmbed()` exported function. Color `0xf59e0b` (orange). |
| [src/events/automodActionExecution.js](../../src/events/automodActionExecution.js) | **create** | Event handler: owned-rule filter, case persistence, mod-log post. All fail-soft. |
| [src/loadEvents.js](../../src/loadEvents.js) | **create** | Auto-discoverer for `src/events/*.js`, registers with `client.on` / `client.once`. |
| [src/commands/automod.js](../../src/commands/automod.js) | **create** | Slash command with subcommands: status, enable, disable, threshold, preset, wordlist {add, remove, list}, exempt {role-add, role-remove, channel-add, channel-remove, list}, resync. Admin-tier gated. |
| [index.js](../../index.js) | modify | Extend `intents` with `AutoModerationConfiguration` + `AutoModerationExecution`. Call `loadEvents(client)` after `loadCommands`. |

**Out-of-scope reminders (NOT in any task — see spec §9):** kill-switch command, auto-resync on `/config` change, host-server invite whitelist, auto-warn pipeline, per-user exemptions.

---

## Task 1: Schema Migration + `createCase` Extension

**Files:**
- Modify: `server/schema.sql` (append at end of file)
- Modify: `src/cases.js` (extend `createCase` signature and SQL)

### - [ ] **Step 1.1: Append schema migration**

Open `server/schema.sql`. At the end of the file (after the existing Stage-3 ALTER), append exactly:

```sql

-- ============================================================
-- Stage 5 Migration: AutoMod Tables + automod_hit Case Type
-- ============================================================
-- Adds the 'automod_hit' meta-case type and two new tables for
-- per-filter state and custom wordlist. See:
-- docs/superpowers/specs/2026-06-04-stage5-automod-design.md §3

-- 1. Extend the case type enum.
ALTER TABLE infractions MODIFY COLUMN type
  ENUM('warn','timeout','kick','ban','unban','untimeout',
       'warn_removed','reason_edited','automod_hit') NOT NULL;

-- 2. Per-filter state. One row per (guild × filter).
CREATE TABLE IF NOT EXISTS automod_rules (
  guild_id         BIGINT UNSIGNED NOT NULL,
  filter_key       ENUM('spam','mention_spam','invite_links',
                        'keyword_preset','custom_wordlist') NOT NULL,
  discord_rule_id  BIGINT UNSIGNED NULL,
  enabled          TINYINT(1) NOT NULL DEFAULT 0,
  threshold        INT UNSIGNED NULL,
  preset_flags     TINYINT UNSIGNED NULL,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (guild_id, filter_key),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
);

-- 3. Custom wordlist (one row per word per guild).
CREATE TABLE IF NOT EXISTS automod_wordlist (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  guild_id    BIGINT UNSIGNED NOT NULL,
  word        VARCHAR(60) NOT NULL,
  added_by    BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  UNIQUE KEY uq_word_per_guild (guild_id, word),
  INDEX idx_guild (guild_id)
);
```

### - [ ] **Step 1.2: Extend `createCase` with `active` parameter**

Open `src/cases.js`. Find `async function createCase({ guildId, userId, moderatorId, type, reason = null, durationMs = null, expiresAt = null, source = 'manual', })` and replace the signature **and the INSERT SQL** as follows.

Replace the signature block (the destructured parameter list):
```js
async function createCase({
  guildId,
  userId,
  moderatorId,
  type,
  reason = null,
  durationMs = null,
  expiresAt = null,
  source = 'manual',
  active = 1,
}) {
```

Find the INSERT INTO infractions statement. The existing version has columns `(guild_id, case_number, user_id, moderator_id, type, source, reason, duration_ms, expires_at)`. Extend it to include `active`:
```js
    const [result] = await conn.execute(
      `INSERT INTO infractions
         (guild_id, case_number, user_id, moderator_id, type, source, reason, duration_ms, expires_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [guildId, caseNumber, userId, moderatorId, type, source, reason, durationMs, expiresAt, active],
    );
```

All existing callers omit `active`, so they get the default `1` — behaviour unchanged.

### - [ ] **Step 1.3: Smoke-load updated `cases.js`**

Run:
```
node -e "require('./src/cases.js')"
```
Expected: exits cleanly with no output. A SyntaxError or thrown exception means stop and fix before continuing.

### - [ ] **Step 1.4: Apply schema and verify**

Restart the bot via Docker so `ensureSchema` runs the new migration:
```
docker compose restart bot
```

Wait ~5 seconds, then check the logs:
```
docker compose logs --tail=40 bot
```
Expected (acceptable lines, in any order):
- `[schema] Skipped duplicate column (errno 1060): ...` for existing ADD COLUMNs from prior stages — these are normal.
- No errors mentioning `automod_rules` or `automod_wordlist`.
- Bot reaches `Deployed 24 command(s)` (still 24 — `/automod` is in Task 4).

If you see `ER_PARSE_ERROR` or anything about the new tables — stop, fix the SQL, restart.

Verify the migration landed by running:
```
docker compose exec mysql mysql -uroot -proot oreo -e "SHOW TABLES LIKE 'automod_%'; DESC automod_rules; DESC automod_wordlist; SHOW COLUMNS FROM infractions LIKE 'type';"
```
Expected:
- `SHOW TABLES` lists `automod_exemptions` (pre-existing), `automod_rules` (new), `automod_wordlist` (new).
- `DESC automod_rules` shows the 7 columns from Step 1.1.
- `DESC automod_wordlist` shows the 5 columns from Step 1.1.
- The `Type` column of `infractions.type` includes `'automod_hit'`.

### - [ ] **Step 1.5: Commit**

```
git add server/schema.sql src/cases.js
git commit -m "$(printf 'feat(schema): Stage 5 AutoMod tables + automod_hit case type\n\n- Extend infractions.type enum with automod_hit\n- New automod_rules table (per-filter state)\n- New automod_wordlist table (per-guild words, max 60 chars/1000 words)\n- Extend createCase with optional active parameter (default 1)\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: DAL Module — `src/automod.js`

**Files:**
- Create: `src/automod.js`

### - [ ] **Step 2.1: Create the file**

Create `src/automod.js` with the full content below. This is the data-access layer plus filter-builder lookup map plus REST wrappers — one cohesive module.

```js
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
  const [[row]] = await getPool().query(
    `SELECT COUNT(*) AS n FROM automod_wordlist WHERE guild_id = ?`,
    [guildId],
  );
  return row.n;
}

async function addWord(guildId, word, addedBy) {
  const normalised = word.trim().toLowerCase();
  if (normalised.length === 0)                     throw new AutoModError('WORD_EMPTY');
  if (normalised.length > LIMIT_WORD_LENGTH)       throw new AutoModError('WORD_TOO_LONG', normalised.length);
  if ((await countWords(guildId)) >= LIMIT_WORDLIST_TOTAL) {
    throw new AutoModError('WORDLIST_FULL', LIMIT_WORDLIST_TOTAL);
  }
  try {
    await getPool().execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [guildId]);
    await getPool().execute(
      `INSERT INTO automod_wordlist (guild_id, word, added_by) VALUES (?, ?, ?)`,
      [guildId, normalised, addedBy],
    );
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
```

### - [ ] **Step 2.2: Smoke-load**

```
node -e "const a = require('./src/automod.js'); console.log(Object.keys(a).length, 'exports'); console.log('FILTER_KEYS:', a.FILTER_KEYS);"
```
Expected:
- A number ≥ 25 followed by `exports`.
- `FILTER_KEYS: [ 'spam', 'mention_spam', 'invite_links', 'keyword_preset', 'custom_wordlist' ]`.

If you see `SyntaxError` or `Cannot find module` — stop, fix, then re-run.

### - [ ] **Step 2.3: Regression check — existing commands still load**

```
node -e "require('./src/loadCommands.js'); const c = new Map(); require('./src/loadCommands.js').loadCommands({ commands: c }); console.log('commands loaded:', c.size);"
```
Expected: `commands loaded: 24` (Stage 5 doesn't add `/automod` yet — that's Task 4).

### - [ ] **Step 2.4: Commit**

```
git add src/automod.js
git commit -m "$(printf 'feat(automod): DAL module with filter builders and REST wrappers\n\nsrc/automod.js exports the per-filter state DAL, custom-wordlist DAL,\nexemption DAL (reusing automod_exemptions), exempt-union helper with\nhard-fail on Discord 20-role / 50-channel limits, trigger-metadata\nbuilders for all 5 filters, REST CRUD wrappers (create/delete/patch/\nfetch) with 10066 unknown-rule handling, and the AutoModError class.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3: Event Handler + Loader + Mod-Log Embed

**Files:**
- Modify: `src/modlog.js` (add new exported function)
- Create: `src/events/automodActionExecution.js`
- Create: `src/loadEvents.js`

### - [ ] **Step 3.1: Add `buildAutoModHitEmbed` to `src/modlog.js`**

Open `src/modlog.js`. Add a new color constant near the existing `COLOR_BAN`/`COLOR_WARN`/`COLOR_TIMEOUT` constants:
```js
const COLOR_AUTOMOD = 0xf59e0b;
```

Then add this function **before** the `module.exports` line:
```js
const FILTER_LABELS = {
  spam:            'Spam',
  mention_spam:    'Mass-Mentions',
  invite_links:    'Invite-Link',
  keyword_preset:  'KeywordPreset',
  custom_wordlist: 'Custom-Wordlist',
};

function buildAutoModHitEmbed({
  caseNumber,
  filterKey,
  userId,
  username,
  channelId,
  content,
  matched,
  ruleId,
}) {
  const { EmbedBuilder } = require('discord.js');
  const label = FILTER_LABELS[filterKey] ?? filterKey;
  const userLine    = username ? `<@${userId}> (${username})` : `<@${userId}>`;
  const channelLine = channelId ? `<#${channelId}>` : 'Unknown channel';

  return new EmbedBuilder()
    .setTitle(`🛡️ AutoMod Hit · Case #${caseNumber}`)
    .setColor(COLOR_AUTOMOD)
    .addFields(
      { name: 'User',     value: userLine,                   inline: false },
      { name: 'Filter',   value: label,                      inline: true  },
      { name: 'Channel',  value: channelLine,                inline: true  },
      { name: 'Trigger',  value: matched || '—',             inline: false },
      { name: 'Content',  value: content || '*(empty)*',     inline: false },
      { name: 'Rule-ID',  value: ruleId ? String(ruleId) : '—', inline: false },
    )
    .setFooter({ text: `Case #${caseNumber} · 🐾` })
    .setTimestamp();
}
```

Replace the existing `module.exports = { buildModLogEmbed };` line with:
```js
module.exports = { buildModLogEmbed, buildAutoModHitEmbed };
```

### - [ ] **Step 3.2: Smoke-load `modlog.js`**

```
node -e "const m = require('./src/modlog.js'); console.log(Object.keys(m));"
```
Expected: `[ 'buildModLogEmbed', 'buildAutoModHitEmbed' ]`.

### - [ ] **Step 3.3: Create `src/loadEvents.js`**

Create the file with this exact content:
```js
const fs = require('node:fs');
const path = require('node:path');

/**
 * Auto-discovers every .js file under src/events/ and registers it on the
 * supplied Discord client. Each event module must export at minimum:
 *
 *   module.exports = { name: Events.<X>, execute: async (...args) => {} };
 *
 * Optional: `once: true` registers via client.once instead of client.on.
 *
 * If src/events/ does not exist this is a silent no-op — so adding the
 * call to index.js is safe even before the first event handler exists.
 */
function loadEvents(client) {
  const dir = path.join(__dirname, 'events');
  if (!fs.existsSync(dir)) return 0;

  let count = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const event = require(path.join(dir, file));
    if (!event?.name || typeof event.execute !== 'function') {
      console.warn(`[loadEvents] skipping ${file}: missing name or execute`);
      continue;
    }
    if (event.once) client.once(event.name, (...args) => event.execute(...args));
    else            client.on(event.name,   (...args) => event.execute(...args));
    count++;
  }
  return count;
}

module.exports = { loadEvents };
```

### - [ ] **Step 3.4: Create `src/events/automodActionExecution.js`**

First make sure the directory exists:
```
mkdir -p src/events
```
On Windows PowerShell:
```
New-Item -ItemType Directory -Force src/events
```

Create `src/events/automodActionExecution.js` with this exact content:
```js
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
      moderatorId: execution.client.user.id,
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
      const user = await execution.client.users.fetch(execution.userId);
      username = user?.tag ?? null;
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
```

### - [ ] **Step 3.5: Smoke-load both new files**

```
node -e "require('./src/loadEvents.js'); require('./src/events/automodActionExecution.js'); console.log('events module OK');"
```
Expected: `events module OK`. Any error here means the handler has a syntax issue — fix before continuing.

### - [ ] **Step 3.6: Regression — restart bot, verify clean log**

```
docker compose restart bot
docker compose logs --tail=50 bot
```
Expected: bot reaches `Deployed 24 command(s)` again (no `/automod` yet — Task 4). No new errors. `loadEvents` is NOT yet called from `index.js` (Task 5), so the new files are loaded only via require — they shouldn't affect runtime behaviour at all.

### - [ ] **Step 3.7: Commit**

```
git add src/modlog.js src/events/automodActionExecution.js src/loadEvents.js
git commit -m "$(printf 'feat(automod): event handler + event-loader infrastructure\n\n- src/loadEvents.js auto-discovers src/events/*.js (pattern for Stage 6+)\n- src/events/automodActionExecution.js: owned-rule filter, fail-soft case\n  insert (type=automod_hit, active=0), fail-soft mod-log embed post\n- src/modlog.js: new buildAutoModHitEmbed (orange 0xf59e0b)\n\nNot wired into index.js yet — that lands in Task 5.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 4: Slash Command — `/automod`

**Files:**
- Create: `src/commands/automod.js`

### - [ ] **Step 4.1: Create the command file**

Create `src/commands/automod.js` with the full content below.

```js
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');

const automod = require('../automod');
const perms   = require('../perms');

const {
  FILTER_KEYS,
  PRESET_BITS,
  PRESET_FLAGS_ALL,
  MENTION_THRESHOLD_DEFAULT,
  TRIGGER_NAMES,
  AutoModError,
} = automod;

// ---- Slash builder ----

const data = new SlashCommandBuilder()
  .setName('automod')
  .setDescription('Configure Oreo AutoMod (admin-only).')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((sc) => sc
    .setName('status')
    .setDescription('Show the state of all AutoMod filters.'))
  .addSubcommand((sc) => sc
    .setName('enable')
    .setDescription('Provision and enable a filter.')
    .addStringOption((o) => o
      .setName('filter').setDescription('Which filter').setRequired(true)
      .addChoices(...FILTER_KEYS.map((k) => ({ name: k, value: k })))))
  .addSubcommand((sc) => sc
    .setName('disable')
    .setDescription('Delete the Discord rule and disable the filter.')
    .addStringOption((o) => o
      .setName('filter').setDescription('Which filter').setRequired(true)
      .addChoices(...FILTER_KEYS.map((k) => ({ name: k, value: k })))))
  .addSubcommand((sc) => sc
    .setName('threshold')
    .setDescription('Set the mention-spam threshold (1–50).')
    .addIntegerOption((o) => o
      .setName('count').setDescription('Mentions per message').setRequired(true)
      .setMinValue(1).setMaxValue(50)))
  .addSubcommand((sc) => sc
    .setName('preset')
    .setDescription('Toggle a Discord KeywordPreset bucket.')
    .addStringOption((o) => o
      .setName('bucket').setDescription('Which bucket').setRequired(true)
      .addChoices(
        { name: 'profanity',      value: 'profanity' },
        { name: 'sexual_content', value: 'sexual_content' },
        { name: 'slurs',          value: 'slurs' },
      ))
    .addBooleanOption((o) => o
      .setName('on').setDescription('Enable this bucket?').setRequired(true)))
  .addSubcommandGroup((g) => g
    .setName('wordlist').setDescription('Custom wordlist CRUD.')
    .addSubcommand((sc) => sc
      .setName('add').setDescription('Add a word.')
      .addStringOption((o) => o
        .setName('word').setDescription('Word (≤60 chars)').setRequired(true)))
    .addSubcommand((sc) => sc
      .setName('remove').setDescription('Remove a word.')
      .addStringOption((o) => o
        .setName('word').setDescription('Word to remove').setRequired(true).setAutocomplete(true)))
    .addSubcommand((sc) => sc
      .setName('list').setDescription('List all words.')))
  .addSubcommandGroup((g) => g
    .setName('exempt').setDescription('Extra exempt roles/channels CRUD.')
    .addSubcommand((sc) => sc
      .setName('role-add').setDescription('Add an extra exempt role.')
      .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand((sc) => sc
      .setName('role-remove').setDescription('Remove an extra exempt role.')
      .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand((sc) => sc
      .setName('channel-add').setDescription('Add an exempt channel.')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true)))
    .addSubcommand((sc) => sc
      .setName('channel-remove').setDescription('Remove an exempt channel.')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true)))
    .addSubcommand((sc) => sc
      .setName('list').setDescription('List effective exempts (auto-baked + extra).')))
  .addSubcommand((sc) => sc
    .setName('resync')
    .setDescription('Re-push current exempt lists to every enabled rule.'));

// ---- Tier gate ----

async function gateOrAbort(interaction) {
  const allowed = await perms.requireTier(interaction, 'owner');
  return allowed;
}

// ---- Autocomplete handler (for wordlist remove) ----

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (interaction.options.getSubcommandGroup(false) !== 'wordlist') return interaction.respond([]);
  if (interaction.options.getSubcommand(false)     !== 'remove')    return interaction.respond([]);
  if (focused.name !== 'word')                                       return interaction.respond([]);

  const words = await automod.getWordlist(interaction.guildId);
  const needle = focused.value.toLowerCase();
  const choices = words
    .filter((w) => w.includes(needle))
    .slice(0, 25)
    .map((w) => ({ name: w, value: w }));
  await interaction.respond(choices);
}

// ---- Error mapping (AutoModError → German user-facing string) ----

function explain(err) {
  if (!(err instanceof AutoModError)) return null;
  switch (err.code) {
    case 'LIMIT_ROLES_20':    return `❌ ${err.detail} Rollen würden exempt sein, Discord erlaubt max 20. Entferne 1+ Rollen mit \`/automod exempt role-remove\`.`;
    case 'LIMIT_CHANNELS_50': return `❌ ${err.detail} Channels exempt, Discord erlaubt max 50. Entferne welche mit \`/automod exempt channel-remove\`.`;
    case 'WORDLIST_FULL':     return `❌ Limit von ${err.detail} Wörtern erreicht. Entferne erst ein Wort.`;
    case 'WORDLIST_EMPTY':    return '❌ `custom_wordlist` ist leer. Erst Wörter mit `/automod wordlist add` hinzufügen.';
    case 'WORD_TOO_LONG':     return `❌ Wort ist ${err.detail} Zeichen, max 60.`;
    case 'WORD_EMPTY':        return '❌ Leeres Wort nicht erlaubt.';
    case 'WORD_DUPLICATE':    return `❌ Wort "${err.detail}" existiert bereits.`;
    case 'WORD_NOT_FOUND':    return `❌ Wort "${err.detail}" nicht in der Wordlist.`;
    case 'EXEMPT_DUPLICATE':  return `❌ Eintrag existiert bereits (${err.detail}).`;
    case 'EXEMPT_NOT_FOUND':  return `❌ Eintrag nicht gefunden (${err.detail}).`;
    case 'UNKNOWN_FILTER':    return `❌ Unbekannter Filter: ${err.detail}.`;
    default:                  return `❌ AutoMod-Fehler: ${err.code}${err.detail !== null ? ` (${err.detail})` : ''}`;
  }
}

function explainDiscord(err) {
  if (err?.code === 50013) return '❌ Mir fehlt die Berechtigung *Manage Guild*. Gib mir die Rolle und versuch\'s nochmal.';
  if (err?.code === 429 || err?.httpStatus === 429) return '⏳ Discord limitiert gerade AutoMod-Edits, bitte ~30 Sek warten.';
  return null;
}

async function ephemeralReply(interaction, content) {
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ content });
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}

// ---- Subcommand: status ----

async function doStatus(interaction) {
  const rows = await automod.getAllRuleStates(interaction.guildId);
  const byKey = new Map(rows.map((r) => [r.filter_key, r]));
  const lines = ['```',
    'Filter            Status   Discord-Rule-ID       Extra',
    '────────────────────────────────────────────────────────'];

  for (const key of FILTER_KEYS) {
    const r = byKey.get(key);
    const label   = (TRIGGER_NAMES[key] ?? key).padEnd(17);
    const status  = r?.enabled ? '✅ on '  : '❌ off';
    const ruleId  = (r?.discord_rule_id ? String(r.discord_rule_id) : '—').padEnd(20);
    let extra = '—';
    if (key === 'mention_spam' && r?.threshold != null) {
      extra = `threshold: ${r.threshold}`;
    } else if (key === 'invite_links' && r?.enabled) {
      extra = `${automod.INVITE_REGEX.length} regex patterns`;
    } else if (key === 'keyword_preset' && r?.preset_flags != null) {
      const buckets = [];
      if (r.preset_flags & PRESET_BITS.profanity)      buckets.push('Profanity');
      if (r.preset_flags & PRESET_BITS.sexual_content) buckets.push('SexualContent');
      if (r.preset_flags & PRESET_BITS.slurs)          buckets.push('Slurs');
      extra = buckets.join(', ') || 'none';
    } else if (key === 'custom_wordlist') {
      const n = await automod.countWords(interaction.guildId);
      extra = `${n} words`;
    }
    lines.push(`${label} ${status}   ${ruleId} ${extra}`);
  }
  lines.push('```');
  await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
}

// ---- Subcommand: enable ----

async function doEnable(interaction) {
  const filterKey = interaction.options.getString('filter', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const existing = await automod.getRuleState(interaction.guildId, filterKey);

  // Default seeding for first enable.
  const defaults = {};
  if (filterKey === 'mention_spam' && existing?.threshold == null) {
    defaults.threshold = MENTION_THRESHOLD_DEFAULT;
  }
  if (filterKey === 'keyword_preset' && existing?.preset_flags == null) {
    defaults.preset_flags = PRESET_FLAGS_ALL;
  }
  if (Object.keys(defaults).length > 0) {
    await automod.upsertRuleState(interaction.guildId, filterKey, defaults);
  }

  // Idempotency: re-use existing rule if Discord still has it.
  if (existing?.discord_rule_id) {
    const fetched = await automod.fetchDiscordRule(interaction.guild, existing.discord_rule_id);
    if (fetched) {
      const exempts = await automod.buildExempts(interaction.guildId);
      await automod.patchDiscordRule(interaction.guild, existing.discord_rule_id, {
        enabled:        true,
        exemptRoles:    exempts.exemptRoles,
        exemptChannels: exempts.exemptChannels,
      });
      await automod.upsertRuleState(interaction.guildId, filterKey, { enabled: 1 });
      return interaction.editReply(`✅ \`${filterKey}\` war bereits provisioned (Rule ${existing.discord_rule_id}) — Status auf an gesetzt, exempts gefrischt.`);
    }
    // 404: zombie state, nuke it and re-create
    await automod.upsertRuleState(interaction.guildId, filterKey, { discord_rule_id: null, enabled: 0 });
  }

  const rule = await automod.createDiscordRule(interaction.guild, filterKey, interaction.user.tag);
  await automod.upsertRuleState(interaction.guildId, filterKey, {
    discord_rule_id: rule.id,
    enabled: 1,
  });
  await interaction.editReply(`✅ \`${filterKey}\` enabled (Discord-Rule-ID \`${rule.id}\`).`);
}

// ---- Subcommand: disable ----

async function doDisable(interaction) {
  const filterKey = interaction.options.getString('filter', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const state = await automod.getRuleState(interaction.guildId, filterKey);
  if (!state || !state.enabled) {
    return interaction.editReply(`ℹ️ \`${filterKey}\` ist bereits disabled.`);
  }
  if (state.discord_rule_id) {
    await automod.deleteDiscordRule(interaction.guild, state.discord_rule_id, `Oreo /automod disable by ${interaction.user.tag}`);
  }
  await automod.upsertRuleState(interaction.guildId, filterKey, { discord_rule_id: null, enabled: 0 });
  await interaction.editReply(`✅ \`${filterKey}\` disabled.`);
}

// ---- Subcommand: threshold ----

async function doThreshold(interaction) {
  const count = interaction.options.getInteger('count', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  await automod.upsertRuleState(interaction.guildId, 'mention_spam', { threshold: count });

  const state = await automod.getRuleState(interaction.guildId, 'mention_spam');
  if (state?.enabled && state?.discord_rule_id) {
    const patched = await automod.patchDiscordRule(interaction.guild, state.discord_rule_id, {
      triggerMetadata: { mentionTotalLimit: count, mentionRaidProtectionEnabled: true },
    });
    if (!patched) {
      await automod.upsertRuleState(interaction.guildId, 'mention_spam', { discord_rule_id: null, enabled: 0 });
      return interaction.editReply(`⚠️ Threshold gespeichert (${count}), aber die Discord-Rule existierte nicht mehr. State zurückgesetzt — neu enablen mit \`/automod enable mention_spam\`.`);
    }
  }
  await interaction.editReply(`✅ Mention-Threshold = ${count}.`);
}

// ---- Subcommand: preset ----

async function doPreset(interaction) {
  const bucket = interaction.options.getString('bucket', true);
  const on     = interaction.options.getBoolean('on',     true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const state = await automod.getRuleState(interaction.guildId, 'keyword_preset');
  const current = state?.preset_flags ?? PRESET_FLAGS_ALL;
  const bit = PRESET_BITS[bucket];
  const next = on ? (current | bit) : (current & ~bit);

  if (next === 0) {
    return interaction.editReply('❌ Mindestens 1 Bucket muss aktiv bleiben. Nutze `/automod disable keyword_preset` um den Filter ganz auszuschalten.');
  }

  await automod.upsertRuleState(interaction.guildId, 'keyword_preset', { preset_flags: next });

  if (state?.enabled && state?.discord_rule_id) {
    const patched = await automod.patchDiscordRule(interaction.guild, state.discord_rule_id, {
      triggerMetadata: { presets: automod.unpackPresets(next), allowList: [] },
    });
    if (!patched) {
      await automod.upsertRuleState(interaction.guildId, 'keyword_preset', { discord_rule_id: null, enabled: 0 });
      return interaction.editReply(`⚠️ Preset-Flags gespeichert, aber die Discord-Rule existierte nicht mehr. State zurückgesetzt.`);
    }
  }
  await interaction.editReply(`✅ Preset \`${bucket}\` → ${on ? 'on' : 'off'}.`);
}

// ---- Subcommand-group: wordlist ----

async function doWordlistAdd(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const word = interaction.options.getString('word', true);
  const stored = await automod.addWord(interaction.guildId, word, interaction.user.id);

  const state = await automod.getRuleState(interaction.guildId, 'custom_wordlist');
  if (state?.enabled && state?.discord_rule_id) {
    const fresh = await automod.getWordlist(interaction.guildId);
    const patched = await automod.patchDiscordRule(interaction.guild, state.discord_rule_id, {
      triggerMetadata: { keywordFilter: fresh, regexPatterns: [], allowList: [] },
    });
    if (!patched) {
      await automod.upsertRuleState(interaction.guildId, 'custom_wordlist', { discord_rule_id: null, enabled: 0 });
      return interaction.editReply(`✅ "${stored}" gespeichert, aber Discord-Rule existierte nicht mehr — state zurückgesetzt.`);
    }
  }
  await interaction.editReply(`✅ "${stored}" hinzugefügt.`);
}

async function doWordlistRemove(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const word = interaction.options.getString('word', true);
  const removed = await automod.removeWord(interaction.guildId, word);

  const state = await automod.getRuleState(interaction.guildId, 'custom_wordlist');
  if (state?.enabled && state?.discord_rule_id) {
    const fresh = await automod.getWordlist(interaction.guildId);
    if (fresh.length === 0) {
      // Disable filter rather than push an empty keyword rule (Discord rejects).
      await automod.deleteDiscordRule(interaction.guild, state.discord_rule_id, 'Wordlist leer');
      await automod.upsertRuleState(interaction.guildId, 'custom_wordlist', { discord_rule_id: null, enabled: 0 });
      return interaction.editReply(`✅ "${removed}" entfernt. Wordlist ist jetzt leer → Filter disabled.`);
    }
    const patched = await automod.patchDiscordRule(interaction.guild, state.discord_rule_id, {
      triggerMetadata: { keywordFilter: fresh, regexPatterns: [], allowList: [] },
    });
    if (!patched) {
      await automod.upsertRuleState(interaction.guildId, 'custom_wordlist', { discord_rule_id: null, enabled: 0 });
    }
  }
  await interaction.editReply(`✅ "${removed}" entfernt.`);
}

async function doWordlistList(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const words = await automod.getWordlist(interaction.guildId);
  if (words.length === 0) return interaction.editReply('*(Wordlist leer.)*');
  const chunks = [];
  let current = '```\n';
  for (const w of words) {
    if (current.length + w.length + 2 > 1900) { current += '```'; chunks.push(current); current = '```\n'; }
    current += w + '\n';
  }
  current += '```';
  chunks.push(current);
  await interaction.editReply(`**Wordlist (${words.length}):**\n${chunks[0]}`);
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp({ content: chunks[i], flags: MessageFlags.Ephemeral });
  }
}

// ---- Subcommand-group: exempt ----

async function pushExemptsToAllEnabled(interaction) {
  const enabled = await automod.getEnabledRuleIds(interaction.guildId);
  if (enabled.length === 0) return { patched: 0, dropped: 0 };
  const exempts = await automod.buildExempts(interaction.guildId);

  let patched = 0, dropped = 0;
  for (const row of enabled) {
    const ok = await automod.patchDiscordRule(interaction.guild, row.discord_rule_id, {
      exemptRoles:    exempts.exemptRoles,
      exemptChannels: exempts.exemptChannels,
    });
    if (ok) {
      patched++;
    } else {
      await automod.upsertRuleState(interaction.guildId, row.filter_key, {
        discord_rule_id: null, enabled: 0,
      });
      dropped++;
    }
  }
  return { patched, dropped };
}

async function doExemptAdd(interaction, targetType) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const option = targetType === 'role'
    ? interaction.options.getRole('role',    true)
    : interaction.options.getChannel('channel', true);
  await automod.addExemption(interaction.guildId, targetType, option.id);
  const { patched, dropped } = await pushExemptsToAllEnabled(interaction);
  const tail = patched
    ? ` Re-synced ${patched} rule(s)${dropped ? `, ${dropped} zombie rule(s) cleared` : ''}.`
    : '';
  await interaction.editReply(`✅ ${targetType === 'role' ? 'Rolle' : 'Channel'} <${targetType === 'role' ? '@&' : '#'}${option.id}> exempt.${tail}`);
}

async function doExemptRemove(interaction, targetType) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const option = targetType === 'role'
    ? interaction.options.getRole('role',    true)
    : interaction.options.getChannel('channel', true);
  await automod.removeExemption(interaction.guildId, targetType, option.id);
  const { patched, dropped } = await pushExemptsToAllEnabled(interaction);
  const tail = patched
    ? ` Re-synced ${patched} rule(s)${dropped ? `, ${dropped} zombie rule(s) cleared` : ''}.`
    : '';
  await interaction.editReply(`✅ Exemption entfernt.${tail}`);
}

async function doExemptList(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const tierRoles  = await automod.getTierRoleIds(interaction.guildId, ['owner', 'moderator']);
  const extraRoles = await automod.getExtraExemptIds(interaction.guildId, 'role');
  const extraChans = await automod.getExtraExemptIds(interaction.guildId, 'channel');
  const lines = ['**Effective exempt list:**',
    `Auto-baked owner/moderator roles: ${tierRoles.length ? tierRoles.map((id) => `<@&${id}>`).join(' ') : '—'}`,
    `Extra exempt roles:               ${extraRoles.length ? extraRoles.map((id) => `<@&${id}>`).join(' ') : '—'}`,
    `Extra exempt channels:            ${extraChans.length ? extraChans.map((id) => `<#${id}>`).join(' ') : '—'}`];
  await interaction.editReply(lines.join('\n'));
}

// ---- Subcommand: resync ----

async function doResync(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { patched, dropped } = await pushExemptsToAllEnabled(interaction);
  if (patched === 0 && dropped === 0) {
    return interaction.editReply('ℹ️ Keine enabled Filter zu syncen.');
  }
  await interaction.editReply(`✅ ${patched} rule(s) re-synced${dropped ? `, ${dropped} zombie rule(s) cleared` : ''}.`);
}

// ---- Dispatcher ----

async function execute(interaction) {
  if (!(await gateOrAbort(interaction))) return;

  const group = interaction.options.getSubcommandGroup(false);
  const sub   = interaction.options.getSubcommand(true);

  try {
    if (!group) {
      if (sub === 'status')    return await doStatus(interaction);
      if (sub === 'enable')    return await doEnable(interaction);
      if (sub === 'disable')   return await doDisable(interaction);
      if (sub === 'threshold') return await doThreshold(interaction);
      if (sub === 'preset')    return await doPreset(interaction);
      if (sub === 'resync')    return await doResync(interaction);
    } else if (group === 'wordlist') {
      if (sub === 'add')    return await doWordlistAdd(interaction);
      if (sub === 'remove') return await doWordlistRemove(interaction);
      if (sub === 'list')   return await doWordlistList(interaction);
    } else if (group === 'exempt') {
      if (sub === 'role-add')       return await doExemptAdd(interaction,    'role');
      if (sub === 'role-remove')    return await doExemptRemove(interaction, 'role');
      if (sub === 'channel-add')    return await doExemptAdd(interaction,    'channel');
      if (sub === 'channel-remove') return await doExemptRemove(interaction, 'channel');
      if (sub === 'list')           return await doExemptList(interaction);
    }
    await ephemeralReply(interaction, `❌ Unknown subcommand: ${group ? `${group} ` : ''}${sub}`);
  } catch (err) {
    const a = explain(err);
    if (a) return ephemeralReply(interaction, a);
    const d = explainDiscord(err);
    if (d) return ephemeralReply(interaction, d);
    console.error('[automod command] unexpected error:', err);
    return ephemeralReply(interaction, '❌ Unerwarteter Fehler. Logs prüfen.');
  }
}

module.exports = { data, execute, autocomplete };
```

### - [ ] **Step 4.2: Smoke-load**

```
node -e "const c = require('./src/commands/automod.js'); console.log('data:', c.data?.name, '| execute:', typeof c.execute, '| autocomplete:', typeof c.autocomplete);"
```
Expected:
```
data: automod | execute: function | autocomplete: function
```

### - [ ] **Step 4.3: Restart bot — `/automod` should deploy**

```
docker compose restart bot
docker compose logs --tail=30 bot
```
Expected: `Deployed 25 command(s)` (24 + new `/automod`). No errors mentioning `automod` from the command loader.

### - [ ] **Step 4.4: Regression smoke — load all commands**

```
docker compose exec bot node -e "const { Collection } = require('discord.js'); const c = { commands: new Collection() }; require('./src/loadCommands.js').loadCommands(c); console.log('total:', c.commands.size); console.log([...c.commands.keys()].sort().join(', '));"
```
Expected:
- `total: 25`
- The sorted list includes `automod` and all 24 prior commands.

### - [ ] **Step 4.5: Commit**

```
git add src/commands/automod.js
git commit -m "$(printf 'feat(automod): /automod slash command with 13 subcommands\n\nAdmin-tier-gated (requireTier owner). Subcommands:\n- status / enable / disable / threshold / preset / resync\n- wordlist {add, remove, list} — remove uses DB autocomplete\n- exempt {role-add, role-remove, channel-add, channel-remove, list}\n\nIdempotent enable (fetches existing rule, reuses on 200, recreates on 404).\nAuto-disables custom_wordlist on last-word-remove (Discord rejects empty\nkeyword rules). All replies ephemeral. AutoModError code → German UX\nmessage mapping.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 5: Wire-up in `index.js` + Final Smoke + E2E Gate

**Files:**
- Modify: `index.js`

### - [ ] **Step 5.1: Inspect current intents and require list**

```
grep -n "GatewayIntentBits\|intents:\|loadCommands\|loadEvents\|client.on\|client.once" index.js
```
Note the exact lines for: the `require('discord.js')` destructuring, the `loadCommands` import, the `intents: [...]` array, the `client.login` call. We'll surgically add three things: an extra require, two extra intents, and a `loadEvents(client)` call.

### - [ ] **Step 5.2: Edit `index.js`**

Three minimal changes — order matters because they need to be added relative to existing lines.

**Change A:** add the `loadEvents` require next to `loadCommands`. Find:
```js
const { loadCommands } = require('./src/loadCommands');
```
Change to:
```js
const { loadCommands } = require('./src/loadCommands');
const { loadEvents }   = require('./src/loadEvents');
```

**Change B:** extend the intents. Find:
```js
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
```
Change to:
```js
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.AutoModerationConfiguration,
    GatewayIntentBits.AutoModerationExecution,
  ],
});
```

**Change C:** call `loadEvents` immediately after `loadCommands(client)` (whichever existing line that is). Find the existing `loadCommands(client)` call and add a line right after:
```js
loadCommands(client);
const _evtCount = loadEvents(client);
console.log(`[startup] Registered ${_evtCount} event handler(s)`);
```

### - [ ] **Step 5.3: Smoke-load `index.js`**

```
node -e "process.env.DISCORD_TOKEN = 'dummy'; process.env.MYSQL_HOST='localhost'; process.env.MYSQL_USER='x'; process.env.MYSQL_PASSWORD='x'; process.env.MYSQL_DATABASE='x'; try { require('./index.js'); } catch (e) { console.log('expected runtime error (no real token/db) — but file parsed OK:', e.code || e.message?.slice(0, 80)); }"
```
Expected: either the script runs and starts trying to connect (then fails), OR it logs `expected runtime error` with a connection/auth error. Both prove the file parses cleanly. A `SyntaxError` here is a real bug.

### - [ ] **Step 5.4: Restart bot and verify full wire-up**

```
docker compose restart bot
docker compose logs --tail=60 bot
```
Expected lines in the boot log:
- No `SyntaxError` / `ReferenceError`.
- `[startup] Registered 1 event handler(s)` (the AutoMod handler).
- `Deployed 25 command(s)`.
- `Ready! Logged in as ...`.

### - [ ] **Step 5.5: Verify intent extension actually took effect**

```
docker compose logs --tail=200 bot | grep -i "intent\|automod"
```
Expected: no warnings about disallowed intents. If you see `DisallowedIntents` — both new intents are non-privileged, so this would mean an SDK-version mismatch; check `package.json` is still on `^14.26.4`.

### - [ ] **Step 5.6: Commit**

```
git add index.js
git commit -m "$(printf 'feat(automod): wire /automod + AutoMod event handler into index.js\n\n- Import loadEvents alongside loadCommands\n- Extend client intents with AutoModerationConfiguration + AutoModerationExecution (both non-privileged)\n- Call loadEvents(client) after loadCommands, log handler count at startup\n\nCloses Stage 5 implementation. Manual E2E follows.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

### - [ ] **Step 5.7: Manual E2E checklist (run by user on a test server)**

Hand the spec §7 checklist to the user verbatim. Do **not** mark the task complete until each checked item passes. The full list:

**Permission (P):**
- [ ] P1: user-tier `/automod status` → ephemeral "Admin-Berechtigung erforderlich"
- [ ] P2: moderator-tier `/automod status` → same denial
- [ ] P3: admin-tier `/automod status` → tabular overview

**Happy path (H):**
- [ ] H1: `/automod enable spam` → Discord Server-Settings → AutoMod lists "Oreo · Spam Detection"
- [ ] H2: trigger spam pattern → blocked + orange mod-log embed + Case # appears
- [ ] H3: `/automod enable mention_spam`; ping 6 users in one message → blocked + Case #
- [ ] H4: `/automod threshold 3` → `/automod status` shows threshold 3
- [ ] H5: `/automod enable invite_links`; post `discord.gg/test` → blocked + Case #
- [ ] H6: `/automod enable keyword_preset`; post a slur → blocked + Case #
- [ ] H7: `/automod enable custom_wordlist` with empty wordlist → "Erst Wörter via …" denial
- [ ] H8: `/automod wordlist add verboten` → `/automod enable custom_wordlist` → post "verboten" → blocked + Case #
- [ ] H9: `/automod disable spam` → rule disappears in Discord-UI, `/automod status` shows off

**Failure (F):**
- [ ] F1: strip ManageGuild from bot → `/automod enable spam` replies "Mir fehlt *Manage Guild*"
- [ ] F2: manually delete rule via Discord-UI → next `/automod status` shows orphan, `/automod enable spam` cleanly re-creates
- [ ] F3: delete mod-log channel, trigger a hit → case still inserted, no bot crash, single `[automod]` error in `docker compose logs`
- [ ] F4: configure 21 admin+mod roles → `/automod enable spam` → "21 Rollen, Discord erlaubt max 20"
- [ ] F5: fill wordlist to 1000 entries → `/automod wordlist add NEW` → "Limit erreicht"

**Limits (M):**
- [ ] M1: `wordlist add` with 61-char word → "Max 60 Zeichen"
- [ ] M2: `wordlist add` duplicate → "existiert bereits"
- [ ] M3: `wordlist add "  Test  "` → trimmed+lowercased to `test`, accepted

**Regression (R):**
- [ ] R1: all 24 existing commands still respond
- [ ] R2: `/modhistory @user` lists the new `automod_hit` cases
- [ ] R3: `/case <n>` on an AutoMod hit shows user/filter/match correctly
- [ ] R4: manual `/warn` still triggers Stage-3 escalation; AutoMod hits do NOT count (verified via DB: `SELECT type, COUNT(*) FROM infractions WHERE active=1 GROUP BY type` shows AutoMod hits at active=0)
- [ ] R5: `/setup` and `/config` work unchanged

### - [ ] **Step 5.8: Push to remote (only after user-confirmed E2E)**

```
git push origin main
```

---

## Self-Review Notes

**Spec coverage:** Each spec section maps to one or more tasks: §2 (architecture) → Tasks 3+5, §3 (schema) → Task 1, §4 (slash command) → Task 4, §5 (rule provisioning) → Task 2, §6 (event handler) → Task 3, §7 (testing) → Step 5.7, §8 (rollback) → not implemented, lives in spec only as runbook.

**Type/method consistency:** Verified — `automod.AutoModError` is created in Task 2 and consumed in Task 4's `explain()` mapper. `automod.getFilterKeyByRuleId` is created in Task 2 and consumed in Task 3's event handler. `modlog.buildAutoModHitEmbed` is created in Task 3 and consumed in Task 3 (same task — handler imports from same module). `cases.createCase({ active })` added in Task 1 is consumed in Task 3's event handler.

**No placeholders:** No TBDs, no "implement appropriate handling" instructions — every code step has the full code block.

**Known smell:** `src/commands/automod.js` is large (~330 lines). Justified because Discord's `SlashCommandBuilder` is intrinsically verbose and the dispatcher needs one branch per subcommand. Splitting into per-subcommand files would force a custom loader pattern that doesn't exist for any other command. Accept the size.
