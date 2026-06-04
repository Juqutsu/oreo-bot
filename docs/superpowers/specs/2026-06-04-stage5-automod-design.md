# Stage 5 — AutoMod Design

> **Status:** Design approved, awaiting implementation plan.
> **Author:** Brainstorming session, 2026-06-04.
> **Predecessors:** Stages 1–4b (cases, config, reports, escalations, utility commands, `/announcement`).
> **Successor:** Stage 6+ (Audit-Log-Mirror, Raid-Protection, Message-Logging) — out of scope here, but Stage 5 establishes the `src/events/` infrastructure that those will reuse.

---

## §1 — Goals & Non-Goals

### Goals
- Add **server-side AutoMod** to Oreo by provisioning Discord-native `AutoModerationRule` objects via the REST API.
- Cover five content/abuse vectors out of the box: generic spam, mass-mentions, invite links, slur/profanity presets, and a per-guild custom wordlist.
- Persist every AutoMod hit as a Case (`type='automod_hit'`, `active=0`) so `/modhistory` and `/case` show a full audit trail.
- Surface a clean admin UX: a single `/automod` slash command with subcommands for enable/disable, threshold, preset bucket toggle, wordlist CRUD, exempt-list CRUD, and resync.
- Auto-bake admin- and moderator-tier roles into every rule's exempt-roles list, so mods don't get filtered by their own bot.
- Stay within **non-privileged intents** — no `MessageContent` request to Discord's Developer Portal.

### Non-Goals (out of scope for Stage 5)
- Custom `messageCreate`-listener-based filtering (would require privileged intent).
- Auto-warn / auto-escalation on AutoMod hits — Stage 5 only logs; mods decide manually.
- Hooking AutoMod hits into the Stage-3 escalation pipeline.
- Per-user (target_type=`user`) exemptions — Discord-native AutoMod doesn't support these.
- Whitelist for the host server's own invite link.
- A master kill-switch slash command (`/automod kill-all`).
- Automatic re-sync of exempt-roles when `/config` changes the tier-role-IDs. (Manual `/automod resync` handles this.)
- Unit-test harness — the bot has no test runner yet; covered by smoke + manual E2E like every prior stage.

---

## §2 — Module Layout & Architecture

### New files
| Path | Responsibility |
|---|---|
| [src/automod.js](../../src/automod.js) | Data-access-layer for `automod_rules` and `automod_wordlist` tables. Filter-builder functions (one per filter) that produce Discord `AutoModerationRule` create-payloads. REST wrappers for create/edit/delete. Exempt-list union helper. |
| [src/events/automodActionExecution.js](../../src/events/automodActionExecution.js) | Event handler for `Events.AutoModerationActionExecution`. Filters on owned rules, creates `automod_hit` case, posts mod-log embed. |
| [src/loadEvents.js](../../src/loadEvents.js) | Auto-discovers `src/events/*.js` files, registers `client.on(event.name, …)` or `client.once(…)`. Analogous to [src/loadCommands.js](../../src/loadCommands.js). |
| [src/commands/automod.js](../../src/commands/automod.js) | Slash-command surface (admin-only). |

### Intent extension in [index.js](../../index.js)
- Current: `intents: [GatewayIntentBits.Guilds]`.
- New: `[GatewayIntentBits.Guilds, GatewayIntentBits.AutoModerationConfiguration, GatewayIntentBits.AutoModerationExecution]`.
- Both new intents are **non-privileged** — no Discord developer-portal request required.

### Bot permission requirements on the guild
- Existing: per-command permissions (Ban Members, Kick Members, Manage Channels, etc.) as in prior stages.
- **New:** `ManageGuild` permission, required by Discord for `AutoModerationRule` CRUD. Missing-perm → friendly ephemeral error from `/automod`, never a crash.

### Reused existing modules (no changes)
- [src/perms.js](../../src/perms.js) — tier-check, used by `/automod` (admin-tier required).
- [src/cases.js](../../src/cases.js) — case-number allocation + infraction insert. Reused for `automod_hit` cases.
- [src/modlog.js](../../src/modlog.js) — embed factory. New `postAutoModHit()` builder added inline (not new file).
- [src/config.js](../../src/config.js) — `getModLogChannelId()` for mod-log posting target.
- [src/escalations.js](../../src/escalations.js) — **not touched**. AutoMod hits are deliberately decoupled from the Stage-3 escalation pipeline (`active=0` ensures they don't count as warns).

### Decoupling rationale
AutoMod-hit cases use `type='automod_hit'` + `active=0`. Stage-3 escalation counts only `active=1, type='warn'`, so AutoMod hits are silently invisible to escalation — exactly what we want, since auto-eskalation on AutoMod is high-false-positive territory.

---

## §3 — Schema Changes

All schema work appends to [server/schema.sql](../../server/schema.sql). The runner [src/schema.js](../../src/schema.js) is idempotent via `errno=1060`/`1061` swallowing.

### Reused (no migration needed)
- `infractions.source` already has `'automod'` in the enum (Stage 1, pre-provisioned).
- `guilds.automod_enabled TINYINT` already exists (Stage 1, never used). **Remains unused in Stage 5** — reserved for a future kill-switch.
- `automod_exemptions(guild_id, target_type, target_id)` already exists (Stage 1, pre-provisioned). Stage 5 uses `target_type='role'` and `target_type='channel'` rows; `target_type='user'` rows are stored but ignored (no native-AutoMod equivalent).

### One ALTER statement (idempotent via `MODIFY COLUMN`)
```sql
-- Stage 5: AutoMod-Hit case type
-- Meta-case (analogous to warn_removed, reason_edited) — represents an event,
-- not a punishment. Stored with active=0 so it doesn't impact escalation counts.
ALTER TABLE infractions MODIFY COLUMN type
  ENUM('warn','timeout','kick','ban','unban','untimeout',
       'warn_removed','reason_edited','automod_hit') NOT NULL;
```

### New table — per-filter state
```sql
-- Stage 5: AutoMod per-filter state.
-- One row per (guild × filter). discord_rule_id=NULL ⇔ filter not currently
-- provisioned in Discord (either never enabled, or disabled).
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
```

- `threshold` — used by `mention_spam` only (default 5).
- `preset_flags` — used by `keyword_preset` only. Bitmask: `0b001=profanity`, `0b010=sexual_content`, `0b100=slurs`. Default `0b111` (all on).

### New table — custom wordlist
```sql
-- Stage 5: Per-guild custom wordlist for the custom_wordlist filter.
-- Discord limits: max 1000 keywords per Keyword rule, max 60 chars per keyword.
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

Words are normalized to lowercase + trimmed by the app before insert. Discord's `keywordFilter` matching is case-insensitive anyway, so storing lowercase keeps the UNIQUE constraint meaningful.

---

## §4 — Slash-Command Surface

Single top-level `/automod` command. Mixed structure: top-level subcommands plus two subcommand-groups (`wordlist`, `exempt`).

### Command tree
```
/automod
├── status                              — overview of all 5 filters
├── enable  <filter>                    — provision + activate a filter
├── disable <filter>                    — delete the Discord rule + mark disabled
├── threshold <count>                   — mention_spam only (range 1–50)
├── preset <bucket> <on:bool>           — keyword_preset bucket toggle
├── wordlist                            (subcommand-group)
│   ├── add    <word>
│   ├── remove <word>                   — DB-backed autocomplete
│   └── list                            — paginated ephemeral embed
├── exempt                              (subcommand-group)
│   ├── role-add       <role>
│   ├── role-remove    <role>
│   ├── channel-add    <channel>
│   ├── channel-remove <channel>
│   └── list                            — shows auto-baked + extra exempts
└── resync                              — re-push exempt-lists to all enabled rules
```

### Permission
All subcommands require **`owner`-tier** (admin). Enforced at the start of `execute()` via the existing `perms.requireTier(interaction, 'owner')` pattern — same as `/setup` and `/config`.

### Autocomplete
- `enable` / `disable` / `threshold`'s `<filter>` argument → static choices: `spam`, `mention_spam`, `invite_links`, `keyword_preset`, `custom_wordlist`.
- `preset`'s `<bucket>` argument → static choices: `profanity`, `sexual_content`, `slurs`.
- `wordlist remove`'s `<word>` argument → dynamic autocomplete from `automod_wordlist` for the current guild, max 25 suggestions, prefix-filtered.
- `exempt role-*` and `exempt channel-*` use Discord-native role/channel option types — no custom autocomplete needed.

### Defaults applied on first `enable`
| Filter | Default |
|---|---|
| `spam` | enabled, no params |
| `mention_spam` | `threshold=5`, `mentionRaidProtectionEnabled=true` |
| `invite_links` | 4 hardcoded Rust-flavored regex patterns (see §5) |
| `keyword_preset` | `preset_flags=0b111` (all three buckets on) |
| `custom_wordlist` | refuses to enable if wordlist empty; tells user to `wordlist add` first |

### Reply shape
All replies **ephemeral** (only the admin sees them).

`/automod status` renders a compact code-block table:
```
Filter            Status   Discord-Rule-ID    Extra
────────────────────────────────────────────────────
Spam              ✅ on    1234567890123      —
Mass-Mentions     ✅ on    1234567890124      threshold: 5
Invite-Links      ✅ on    1234567890125      4 regex patterns
KeywordPreset     ✅ on    1234567890126      Profanity, Slurs
Custom-Wordlist   ❌ off   —                  0 words
```

### Validation
- `wordlist add`: word ≤ 60 chars, no whitespace-only, ≤ 1000 total words per guild, UNIQUE per guild (lowercase-trimmed).
- `threshold`: integer 1–50 (Discord allows 1–50 for `mentionTotalLimit`).
- `exempt role-add` / `channel-add`: no duplicates; warns if role is already auto-baked (still allows, but informs).

### Error responses (all ephemeral, fail-soft)
| Condition | Reply |
|---|---|
| Bot lacks `ManageGuild` | „Mir fehlt die Berechtigung *Manage Guild*. Gib mir die Rolle und versuch's nochmal." |
| Discord rate-limit (HTTP 429) | „Discord limitiert gerade AutoMod-Edits, bitte ~30 Sek warten." |
| Rule deleted in Discord-UI (404 on edit) | DB-State auf `discord_rule_id=NULL, enabled=0` setzen + Hinweis: „Rule existierte nicht mehr in Discord. State zurückgesetzt — neu enablen falls gewollt." |
| Exempt-roles union > 20 | „21 Rollen würden exempt sein, Discord erlaubt max 20. Entferne 1+ Rollen mit /automod exempt role-remove." |
| Wordlist at 1000 limit | „Limit von 1000 Wörtern erreicht. Entferne erst ein Wort." |
| Wordlist empty on enable | „custom_wordlist ist leer. Erst Wörter mit /automod wordlist add hinzufügen." |
| Duplicate word | „Wort existiert bereits." |
| Word > 60 chars | „Max 60 Zeichen pro Wort." |

---

## §5 — Rule Provisioning (Discord-API Mapping)

### Common skeleton
```js
function baseRulePayload(name, exempts, moderatorTag) {
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
    reason: `Oreo /automod enable — provisioned by ${moderatorTag}`,
  };
}
```

### Exempt-list union helper
```js
async function buildExempts(guildId) {
  const tierRoles  = await perms.getTierRoleIds(guildId, ['owner', 'moderator']);
  const extraRoles = await automod.getExtraExemptIds(guildId, 'role');
  const extraChans = await automod.getExtraExemptIds(guildId, 'channel');

  const exemptRoles    = [...new Set([...tierRoles, ...extraRoles])];
  const exemptChannels = [...new Set(extraChans)];

  if (exemptRoles.length    > 20) throw new AutoModError('LIMIT_ROLES_20', exemptRoles.length);
  if (exemptChannels.length > 50) throw new AutoModError('LIMIT_CHANNELS_50', exemptChannels.length);

  return { exemptRoles, exemptChannels };
}
```
**Hard-fail on limit** — never silently truncate. The error carries the actual count so the reply can be specific.

### Per-filter trigger metadata
| `filter_key` | `triggerType` | `triggerMetadata` |
|---|---|---|
| `spam` | `Spam` | `{}` |
| `mention_spam` | `MentionSpam` | `{ mentionTotalLimit: <threshold>, mentionRaidProtectionEnabled: true }` |
| `invite_links` | `Keyword` | `{ regexPatterns: INVITE_REGEX, keywordFilter: [], allowList: [] }` |
| `keyword_preset` | `KeywordPreset` | `{ presets: unpackPresets(preset_flags), allowList: [] }` |
| `custom_wordlist` | `Keyword` | `{ keywordFilter: [...lowercased words from DB...], regexPatterns: [], allowList: [] }` |

### Invite-link Rust-regex patterns (hardcoded in `src/automod.js`)
```js
const INVITE_REGEX = [
  String.raw`discord\.gg/[\w-]+`,
  String.raw`discord(?:app)?\.com/invite/[\w-]+`,
  String.raw`dsc\.gg/[\w-]+`,
  String.raw`invite\.gg/[\w-]+`,
];
```
Discord limits: max 10 regex patterns per rule, max 260 chars each. We use 4, all ≤30 chars.

### Preset bitmask helpers
```js
const PRESET_BITS = {
  profanity:       0b001,
  sexual_content:  0b010,
  slurs:           0b100,
};

function unpackPresets(flags) {
  const out = [];
  if (flags & 0b001) out.push(AutoModerationRuleKeywordPresetType.Profanity);
  if (flags & 0b010) out.push(AutoModerationRuleKeywordPresetType.SexualContent);
  if (flags & 0b100) out.push(AutoModerationRuleKeywordPresetType.Slurs);
  return out;
}
```

### Lifecycle operation table
| `/automod` action | DB write | Discord-API call |
|---|---|---|
| `enable <filter>` | UPSERT `automod_rules` with `enabled=1` | `guild.autoModerationRules.create(payload)` → store returned `discord_rule_id` |
| `disable <filter>` | UPDATE `enabled=0, discord_rule_id=NULL` | `rule.delete(reason)` |
| `threshold <n>` | UPDATE `threshold=n` | `rule.edit({ triggerMetadata: { mentionTotalLimit: n, mentionRaidProtectionEnabled: true } })` |
| `preset <bucket> on/off` | UPDATE `preset_flags` bitmask | `rule.edit({ triggerMetadata: { presets: unpackPresets(flags) } })` |
| `wordlist add/remove` | INSERT/DELETE in `automod_wordlist` | if `custom_wordlist.enabled=1`: re-fetch full list, `rule.edit({ triggerMetadata: { keywordFilter: [...fresh] } })` |
| `exempt role-add/remove` | INSERT/DELETE in `automod_exemptions` | for every enabled rule: `rule.edit({ exemptRoles: [...union] })` |
| `exempt channel-add/remove` | INSERT/DELETE in `automod_exemptions` | for every enabled rule: `rule.edit({ exemptChannels: [...union] })` |
| `resync` | — | for every enabled rule: re-push `exemptRoles` and `exemptChannels` from current DB state |

### Race-safety on wordlist edits
Two concurrent `wordlist add` calls each see a stale in-memory snapshot and race to overwrite the rule. **Mitigation:** the wordlist write helper always reads the *fresh* DB state immediately before the `rule.edit` call, so the last-write-wins payload is always the complete set.

### Idempotency on enable
`/automod enable <filter>` when DB already has `discord_rule_id != NULL`:
1. `guild.autoModerationRules.fetch(id)` — if 200: rule still exists, just re-push current exempts and metadata (no-op-ish).
2. If 404: rule was manually deleted in Discord-UI. Null the `discord_rule_id` in DB, recreate fresh.

This handles the „admin nuked the rule in Discord-UI"-drift cleanly.

---

## §6 — Event Handler: `AutoModerationActionExecution`

File: [src/events/automodActionExecution.js](../../src/events/automodActionExecution.js).

### Why we get `content` without privileged intent
Discord includes the full message `content`, `matchedContent`, and `matchedKeyword` in the `AutoModerationActionExecution` event payload **only for rules that the receiving bot owns**. Since we created the rules, we read the content here without ever needing `MessageContent` (which is privileged). For rules owned by other bots, those fields are `null` — and we filter those out anyway.

### Handler flow
```js
async function execute(execution) {
  // 1. Owned-rule filter
  const filterKey = await automod.getFilterKeyByRuleId(
    execution.guild.id, execution.ruleId
  );
  if (!filterKey) return;

  // 2. Allocate case number
  const caseNumber = await cases.nextCaseNumber(execution.guild.id);

  // 3. Persist case (fail-soft — never crash event loop)
  try {
    await cases.insertInfraction({
      guildId:     execution.guild.id,
      caseNumber,
      userId:      execution.userId,
      moderatorId: execution.client.user.id,
      type:        'automod_hit',
      source:      'automod',
      reason:      buildReason(execution, filterKey),
      active:      0,
    });
  } catch (err) {
    console.error('[automod] failed to persist case', err);
  }

  // 4. Mod-log post (fail-soft)
  try {
    await modlog.postAutoModHit({
      guild: execution.guild,
      caseNumber,
      filterKey,
      userId:    execution.userId,
      channelId: execution.channelId,
      content:   truncate(execution.content ?? '', 500),
      matched:   truncate(execution.matchedContent ?? execution.matchedKeyword ?? '—', 100),
      ruleId:    execution.ruleId,
    });
  } catch (err) {
    console.error('[automod] failed to post mod-log', err);
  }
}

module.exports = { name: Events.AutoModerationActionExecution, execute };
```

### `reason` field format (≤ 512 chars, hard-truncated)
```
[AutoMod: invite_links] match="discord.gg/spam" in #general
```
Compact and searchable, so `/modhistory` and `/case` show actionable detail. `buildReason()` truncates the `matchedContent`/`matchedKeyword` value to 100 chars before formatting (same value as the embed's `matched` field), guaranteeing the final string fits the 512-char DB column even if the worst-case channel name is long.

### Mod-log embed shape
```
🛡️  AutoMod Hit · Case #347                       (color: 0xf59e0b — orange)
─────────────────────────────────────────────────
User       @badactor (192…871)
Filter     Invite-Link
Channel    #general
Trigger    "discord.gg/freenitro"
Content    check this out fam discord.gg/freenitro real legit drop today
Rule-ID    1234567890123456789
─────────────────────────────────────────────────
                                          12:34 PM
```
- **Color `0xf59e0b` (orange)** to visually separate passive AutoMod logs from active mod-actions (which use blue/red).
- 500-char truncation on `content`, 100-char truncation on `matched` — consistent with the truncation pattern from Stage 4 lockdown/announcement embeds.
- Footer shows the case timestamp. No clickable case-link button — `/case <n>` is the lookup path.

### Fail-soft paths (handler never crashes)
- DB insert fails → `console.error`, continue to mod-log.
- Mod-log channel not configured → `getModLogChannelId()` returns `null`, post step silently skips. Case still exists.
- Mod-log channel deleted or perms revoked → caught error, `console.error`, no crash.
- User or channel not fetchable → embed shows `Unknown User (ID: …)` / `Unknown Channel (ID: …)`.

### Event-loader pattern
[src/loadEvents.js](../../src/loadEvents.js):
```js
const fs = require('node:fs');
const path = require('node:path');

function loadEvents(client) {
  const dir = path.join(__dirname, 'events');
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const event = require(path.join(dir, file));
    if (event.once) client.once(event.name, (...a) => event.execute(...a));
    else            client.on(event.name,   (...a) => event.execute(...a));
  }
}

module.exports = { loadEvents };
```
Wired in [index.js](../../index.js) once at boot, before `client.login`. Future stages add more files to `src/events/` without touching `index.js`.

---

## §7 — Testing & Failure Modes

### Smoke tests (per-task, automated via `node -e require`)
- [src/automod.js](../../src/automod.js), [src/events/automodActionExecution.js](../../src/events/automodActionExecution.js), [src/loadEvents.js](../../src/loadEvents.js), [src/commands/automod.js](../../src/commands/automod.js) all load without throwing.
- Bot starts via `docker compose up` without errors; log reports **„Deployed 25 command(s)"** (24 prior + `/automod`).
- Schema migration runs idempotently — second startup logs only the expected `errno 1060`/`1061` skip messages.

### E2E manual checklist (run by user on a test server)

**Permission gating (P):**
- P1: User-tier `/automod status` → ephemeral „❌ Admin-Berechtigung erforderlich".
- P2: Moderator-tier `/automod status` → same denial.
- P3: Admin-tier `/automod status` → tabular overview rendered.

**Happy path per filter (H):**
- H1: `/automod enable spam` → Discord Server-Settings → AutoMod shows new rule „Oreo · Spam Detection".
- H2: Trigger a known-spam pattern → message blocked, Case #N created, orange mod-log embed posted.
- H3: `/automod enable mention_spam`; user pings 6 distinct members in one message → blocked, case logged.
- H4: `/automod threshold 3` → `/automod status` confirms threshold updated to 3.
- H5: `/automod enable invite_links`; post `discord.gg/test` → blocked.
- H6: `/automod enable keyword_preset`; post a slur → blocked.
- H7: `/automod enable custom_wordlist` while wordlist empty → ❌ „Erst Wörter via `/automod wordlist add` hinzufügen".
- H8: `/automod wordlist add verboten` → `/automod enable custom_wordlist` → posting „verboten" → blocked.
- H9: `/automod disable spam` → rule disappears from Discord-UI, `/automod status` shows off.

**Failure modes (F):**
- F1: Strip `ManageGuild` from bot role → `/automod enable` replies „Mir fehlt *Manage Guild*".
- F2: Delete a rule manually via Discord-UI → next `/automod status` shows it as orphan; `/automod enable` cleanly re-creates.
- F3: Delete the mod-log channel, then trigger a hit → case is still persisted, no bot crash, single `console.error` in logs.
- F4: With 21 admin+mod roles and 0 extras → `/automod enable` ❌ „21 Rollen, Discord erlaubt max 20".
- F5: Fill wordlist to 1000 entries → `/automod wordlist add …` ❌ „Limit erreicht".

**Limits (M):**
- M1: `wordlist add` with 61-char word → ❌ „Max 60 Zeichen".
- M2: `wordlist add` with a duplicate → ❌ „Wort existiert bereits".
- M3: `wordlist add` with surrounding whitespace → trimmed, lowercased, accepted.

**Regression (R):**
- R1: All 24 existing commands still load and dispatch correctly.
- R2: `/modhistory @user` lists `automod_hit` cases.
- R3: `/case <n>` on an AutoMod hit shows user / filter / matched content correctly.
- R4: Manual `/warn` still increments warn-count and triggers Stage-3 escalation. AutoMod hits do **not** count (verified by `active=0` + `type='automod_hit'`).
- R5: `/setup` and `/config` behave identically to pre-Stage-5.

### Not tested in Stage 5
- Unit tests (no harness exists; Stage-9+).
- Load tests against Discord rate-limits (issues surface in logs; debug reactively).
- Cross-guild isolation (no shared-state concerns; primary key always includes `guild_id`).

---

## §8 — Rollback

### Code rollback
Stage 5 ships as ~5 commits, one per task: schema migration → `src/automod.js` DAL → event handler + loader → `/automod` command → `index.js` wiring (intents + `loadEvents` call). Each commit is individually `git revert`-safe.

### Schema rollback (manual, forward-only migration)
The schema migration cannot be auto-reversed (no `down` mechanism). Manual SQL if needed:
```sql
-- 1. Remove AutoMod-hit rows first (otherwise the ALTER below fails).
DELETE FROM infractions WHERE type = 'automod_hit';

-- 2. Reduce the type enum back to the Stage-4 shape.
ALTER TABLE infractions MODIFY COLUMN type
  ENUM('warn','timeout','kick','ban','unban','untimeout',
       'warn_removed','reason_edited') NOT NULL;

-- 3. Drop the Stage-5 tables.
DROP TABLE IF EXISTS automod_wordlist;
DROP TABLE IF EXISTS automod_rules;
```
`automod_exemptions` and `guilds.automod_enabled` are untouched — they existed pre-Stage-5.

### Discord-side cleanup
- **Ideal:** run `/automod disable <filter>` for each of the 5 filters *before* code-revert. The bot cleans up the rules in Discord automatically.
- **Emergency (code already reverted):** Server-Settings → AutoMod → manually delete the 5 „Oreo · …"-rules.

### Intent rollback
Remove `AutoModerationConfiguration` and `AutoModerationExecution` from the `intents` array in [index.js](../../index.js), re-deploy. No side-effect on other commands.

---

## §9 — Out of Scope / Future Stages

These items are deliberately deferred and listed here so we don't lose them:

- **Stage 6 — Audit-Log-Mirror.** Listen to `Events.GuildAuditLogEntryCreate` and mirror bans/kicks/role-changes performed via Discord-UI into the mod-log + case-system. Reuses the `src/events/` infrastructure built here.
- **Stage 7 — Raid-Protection.** `guildMemberAdd` listener with account-age gate and mass-join detection. Reuses event loader.
- **Stage 8 — Message-Logging.** `messageDelete` / `messageUpdate` to an audit channel. Requires evaluating whether to opt into `MessageContent` privileged intent.
- **Auto-resync on `/config` changes.** When tier-role IDs change via `/config`, push fresh exempt-lists to all enabled AutoMod rules. Currently manual via `/automod resync`.
- **Whitelist for host server's own invite link.** Allow the guild's own `discord.gg/<vanity>` to slip past `invite_links`.
- **`/automod kill-all` command.** Master kill-switch that disables all 5 filters and zeros `guilds.automod_enabled`.
- **AutoMod-hit → auto-warn pipeline.** Optional opt-in mode where AutoMod hits convert to real warns and feed Stage-3 escalation. Currently every AutoMod hit is `active=0` (passive log).
- **Per-user exemptions.** Discord-native AutoMod doesn't support these; would require a custom listener and `MessageContent` privileged intent.
