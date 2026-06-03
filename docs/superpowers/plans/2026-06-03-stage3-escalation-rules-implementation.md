# Stage 3 Escalation Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement auto-escalation — when `/warn` brings a user's active warn count to a configured threshold N, the bot automatically applies `timeout`/`kick`/`ban` per the matching rule, writes an `escalation`-sourced infraction case, and posts a mod-log entry; admins manage rules via `/config escalation set|unset|list`.

**Architecture:** Single new module `src/escalations.js` bundles rule-CRUD + apply-logic; `/warn` calls `applyEscalation` after its existing mod-log post (best-effort). One additive schema migration (ENUM extension). `/config` gets a 4th subcommand-group `escalation`. `cases.createCase` already accepts `source` — only the schema needs the new enum value.

**Tech Stack:** Node.js 20.6+, discord.js v14, mysql2/promise, plain JS, no transpiler. Smoke-tests use `node --env-file=.env tests/smoke/<file>.js`. Docker Compose for MySQL + bot.

**Spec:** `docs/superpowers/specs/2026-06-03-stage3-escalation-rules-design.md`

---

## File Plan

```
NEU
├── src/escalations.js                              (Task 2 + Task 3)
└── tests/smoke/escalations.js                      (Task 2)

GEÄNDERT
├── server/schema.sql                               (Task 1, +5 LoC ENUM ALTER)
├── src/commands/warn.js                            (Task 3, +5 LoC wire-up + import)
└── src/commands/config.js                          (Task 4, +~130 LoC subgroup + show integration)
```

**Pre-existing infrastructure (no code changes needed):**
- `cases.createCase` already accepts `source` parameter (default `'manual'`); only ENUM expansion blocks `source: 'escalation'` today.
- `escalation_rules` table exists since Stage 1 (`server/schema.sql:64`); currently unused.
- `src/duration.js` exports `parseDuration`, `formatDuration`, `MAX_TIMEOUT_MS`.
- `src/modlog.js` exports `buildModLogEmbed` (Stage 2d).
- `cases.countActiveWarnings(guildId, userId)` exists (`src/cases.js:86`).
- `src/config.js` exports `getModLogChannelId(guildId)`.

**Task order rationale:**
1. Schema first — Task 2's smoke test will write rows with `action='timeout'`, which uses an existing ENUM value, so schema alone is enough. But the source-ENUM extension is needed before Task 3's `applyEscalation` actually inserts `source='escalation'` cases. Both blockers cleared in Task 1.
2. DAL with smoke test (Task 2) is independent of Discord — TDD-friendly, isolated.
3. `applyEscalation` + `/warn` wire-up (Task 3) is the Discord-integration step; manual E2E later.
4. `/config escalation` subcommand-group + show-integration (Task 4) builds on the DAL from Task 2.
5. Final manual E2E + push (Task 5).

---

## Task 1: Schema-Migration — Extend `infractions.source` ENUM

**Files:**
- Modify: `server/schema.sql` (append a new Stage-3 migration block at end of file, after Stage-2d `idx_resolution_case` block on line 154)

**Why:** `infractions.source` is currently `ENUM('manual','automod','api')`. Stage 3 auto-escalation cases need a fourth value `'escalation'` so they can be distinguished from manual mod actions, future automod (Stage 4), and api-driven cases.

- [ ] **Step 1: Read end-of-file to confirm append point**

Read the last 10 lines of `server/schema.sql`. The Stage-2d block ends with `ALTER TABLE reports ADD INDEX idx_resolution_case (guild_id, resolution_case_number);` followed by a trailing newline. Append after that.

- [ ] **Step 2: Append migration block**

Add to the very end of `server/schema.sql`:

```sql

-- ============================================================
-- Stage 3 Migration: Escalation Source Tag
-- ============================================================
-- Erweitert infractions.source um 'escalation', damit Auto-
-- Eskalations-Cases von manuellen, automod-, und api-Cases
-- unterscheidbar sind. Additiv — bestehende Rows unverändert.

ALTER TABLE infractions MODIFY COLUMN source
  ENUM('manual','automod','api','escalation') NOT NULL DEFAULT 'manual';
```

Note: `MODIFY COLUMN` is the right syntax for ENUM extension (not `ADD COLUMN`). It does not change existing rows.

- [ ] **Step 3: Run schema migration against the live MySQL**

```powershell
node --env-file=.env -e "require('./src/schema').ensureSchema().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})"
```

Expected: process exits 0. There may or may not be a "Skipped duplicate" log — `MODIFY COLUMN` is idempotent at the ENUM-shape level: if the column already has the new shape, MySQL applies a no-op (no error). If the column doesn't have `'escalation'` yet, it adds it.

If the runner errors with anything other than errno 1060/1061 (which are swallowed already): investigate. ENUM-shape mismatches between code and DB might surface as a different errno.

- [ ] **Step 4: Verify the ENUM contains 'escalation'**

```powershell
docker compose --project-directory "c:/Users/Lukas/Documents/Oreo" exec mysql mysql -u root -p${env:MYSQL_ROOT_PASSWORD} oreo -e "SHOW COLUMNS FROM infractions LIKE 'source';"
```

Expected output (the `Type` column):
```
enum('manual','automod','api','escalation')
```

If the password env-var name differs in your `.env`, use the correct one (check `.env` first).

- [ ] **Step 5: Idempotency re-run**

Run Step 3 a second time. Expected: process exits 0, no new visible change. MySQL recognizes the column already has the desired shape.

- [ ] **Step 6: Commit**

```powershell
git add server/schema.sql
git commit -m @'
feat(schema): Stage 3 add escalation source enum value

Erweitert infractions.source um 'escalation' fuer Auto-Eskalations-
Cases. Additiv via MODIFY COLUMN; bestehende Rows bleiben auf
'manual'/'automod'/'api'. Idempotent (no-op bei wiederholtem Run).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 2: `src/escalations.js` DAL + Smoke Test

**Files:**
- Create: `src/escalations.js` (DAL functions only — `applyEscalation` added in Task 3)
- Create: `tests/smoke/escalations.js`

**TDD-Reihenfolge:** Write the failing smoke test first (red), then implement DAL until green.

- [ ] **Step 1: Write the failing smoke test**

Create `tests/smoke/escalations.js`:

```js
// Run with: node --env-file=.env tests/smoke/escalations.js
const escalations = require('../../src/escalations');
const { getPool } = require('../../src/db');
const assert = require('node:assert/strict');

const GUILD = '888888888888888100';

async function main() {
  const pool = getPool();

  // Ensure parent guild row exists (FK constraint)
  await pool.query(
    `INSERT INTO guilds (guild_id, next_case_number)
       VALUES (?, 1) ON DUPLICATE KEY UPDATE guild_id = guild_id`,
    [GUILD],
  );

  // Cleanup any old test rows
  await pool.query(`DELETE FROM escalation_rules WHERE guild_id = ?`, [GUILD]);

  // --- setRule + getRuleForThreshold roundtrip ---
  await escalations.setRule(GUILD, 3, 'timeout', 30);
  const rule3 = await escalations.getRuleForThreshold(GUILD, 3);
  assert.ok(rule3, 'rule for threshold=3 exists');
  assert.equal(rule3.action, 'timeout');
  assert.equal(Number(rule3.duration_minutes), 30);
  assert.equal(Number(rule3.warn_threshold), 3);
  console.log('✓ setRule + getRuleForThreshold roundtrip');

  // --- setRule UPSERT (overwrite existing) ---
  await escalations.setRule(GUILD, 3, 'kick', null);
  const rule3upd = await escalations.getRuleForThreshold(GUILD, 3);
  assert.equal(rule3upd.action, 'kick');
  assert.equal(rule3upd.duration_minutes, null);
  console.log('✓ setRule UPSERT overwrites action+duration');

  // --- listRules sorted by threshold ASC ---
  await escalations.setRule(GUILD, 5, 'ban', null);
  await escalations.setRule(GUILD, 10, 'ban', null);
  const list = await escalations.listRules(GUILD);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((r) => Number(r.warn_threshold)), [3, 5, 10]);
  console.log('✓ listRules sorted ASC');

  // --- removeRule returns affectedRows ---
  const removed = await escalations.removeRule(GUILD, 5);
  assert.equal(removed, 1);
  const removedAgain = await escalations.removeRule(GUILD, 5);
  assert.equal(removedAgain, 0, 'second remove returns 0');
  const listAfter = await escalations.listRules(GUILD);
  assert.equal(listAfter.length, 2);
  console.log('✓ removeRule returns affectedRows');

  // --- getRuleForThreshold returns null on miss ---
  const missing = await escalations.getRuleForThreshold(GUILD, 999);
  assert.equal(missing, null);
  console.log('✓ getRuleForThreshold returns null on miss');

  // Cleanup
  await pool.query(`DELETE FROM escalation_rules WHERE guild_id = ?`, [GUILD]);

  console.log('OK — escalations smoke test passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
```

- [ ] **Step 2: Run test, verify it fails with "Cannot find module"**

```powershell
node --env-file=.env tests/smoke/escalations.js
```

Expected: `Error: Cannot find module '../../src/escalations'`. Confirms TDD-red state.

- [ ] **Step 3: Implement `src/escalations.js` DAL skeleton**

Create `src/escalations.js`:

```js
const { getPool } = require('./db');

/**
 * Liefert die Eskalations-Regel für eine exakte Warn-Schwelle.
 * @param {string} guildId
 * @param {number} threshold
 * @returns {Promise<object|null>} { id, guild_id, warn_threshold, action, duration_minutes } oder null
 */
async function getRuleForThreshold(guildId, threshold) {
  const [rows] = await getPool().execute(
    `SELECT id, guild_id, warn_threshold, action, duration_minutes
       FROM escalation_rules
      WHERE guild_id = ? AND warn_threshold = ?
      LIMIT 1`,
    [guildId, threshold],
  );
  return rows[0] ?? null;
}

/**
 * Listet alle Eskalations-Regeln einer Guild, sortiert nach Schwelle aufsteigend.
 * @param {string} guildId
 * @returns {Promise<object[]>}
 */
async function listRules(guildId) {
  const [rows] = await getPool().execute(
    `SELECT id, warn_threshold, action, duration_minutes
       FROM escalation_rules
      WHERE guild_id = ?
      ORDER BY warn_threshold ASC`,
    [guildId],
  );
  return rows;
}

/**
 * Setzt oder aktualisiert eine Eskalations-Regel (UPSERT auf uq_threshold_per_guild).
 * @param {string} guildId
 * @param {number} threshold
 * @param {'timeout'|'kick'|'ban'} action
 * @param {number|null} durationMinutes  (nur bei action='timeout' relevant; sonst null)
 * @returns {Promise<void>}
 */
async function setRule(guildId, threshold, action, durationMinutes) {
  await getPool().execute(
    `INSERT INTO escalation_rules (guild_id, warn_threshold, action, duration_minutes)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE action = VALUES(action), duration_minutes = VALUES(duration_minutes)`,
    [guildId, threshold, action, durationMinutes],
  );
}

/**
 * Entfernt eine Eskalations-Regel.
 * @param {string} guildId
 * @param {number} threshold
 * @returns {Promise<number>} affectedRows (0 wenn keine Regel existierte)
 */
async function removeRule(guildId, threshold) {
  const [result] = await getPool().execute(
    `DELETE FROM escalation_rules WHERE guild_id = ? AND warn_threshold = ?`,
    [guildId, threshold],
  );
  return result.affectedRows;
}

module.exports = {
  getRuleForThreshold,
  listRules,
  setRule,
  removeRule,
};
```

- [ ] **Step 4: Run smoke test, verify it passes**

```powershell
node --env-file=.env tests/smoke/escalations.js
```

Expected: 5 `✓`-lines + final `OK — escalations smoke test passed`. Exit 0.

If any assertion fails, fix the DAL implementation and re-run before moving on.

- [ ] **Step 5: Commit**

```powershell
git add src/escalations.js tests/smoke/escalations.js
git commit -m @'
feat(escalations): rule DAL module + smoke test

src/escalations.js exports getRuleForThreshold, listRules, setRule,
removeRule. setRule uses UPSERT auf uq_threshold_per_guild. Smoke-Test
deckt roundtrip + UPSERT + sort + remove + null-on-miss ab.

applyEscalation-Funktion (Discord-Action + Case-Schreiben) folgt in
Task 3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 3: `applyEscalation` Function + `/warn` Wire-Up

**Files:**
- Modify: `src/escalations.js` (extend with `applyEscalation` + helpers — no test, Discord-side-effects)
- Modify: `src/commands/warn.js` (import escalations, call `applyEscalation` after mod-log)

**No automated test** — `applyEscalation` calls Discord APIs (timeout/kick/ban) and posts mod-log embeds. Verification happens in Task 5 manual E2E. For now, Step 5 below smoke-loads the modules to catch syntax errors.

- [ ] **Step 1: Extend `src/escalations.js` with `applyEscalation`**

Add these imports at the top of `src/escalations.js`:

```js
const { EmbedBuilder } = require('discord.js');
const cases = require('./cases');
const config = require('./config');
const { buildModLogEmbed } = require('./modlog');
const { formatDuration } = require('./duration');
```

Then add the function above `module.exports`:

```js
/**
 * Prüft ob für den gegebenen active-Warn-Count eine Eskalations-Regel existiert
 * und führt sie aus (Discord-Action + Case + Mod-Log-Embed). Best-effort:
 * Discord-Failure → fail-Embed im Mod-Log, kein Case. Stage 3 Spec §3.
 *
 * @param {object} args
 * @param {import('discord.js').ChatInputCommandInteraction} args.interaction
 * @param {import('discord.js').User} args.target     User aus interaction.options.getUser('user')
 * @param {number} args.activeWarnCount               Aktuelle aktive Warn-Anzahl des targets nach dem Warn
 * @returns {Promise<{caseNumber: number, action: string}|null>}
 *          null wenn keine Regel matched ODER Discord-Action gescheitert ist;
 *          { caseNumber, action } bei erfolgreicher Eskalation.
 */
async function applyEscalation({ interaction, target, activeWarnCount }) {
  const guildId = interaction.guildId;
  const rule = await getRuleForThreshold(guildId, activeWarnCount);
  if (!rule) return null;

  const action = rule.action; // 'timeout' | 'kick' | 'ban'
  const threshold = Number(rule.warn_threshold);
  const durationMinutes = rule.duration_minutes ? Number(rule.duration_minutes) : null;
  const durationMs = action === 'timeout' && durationMinutes ? durationMinutes * 60_000 : null;
  const reason = `Auto-Eskalation (Schwelle: ${threshold} aktive Warns)`;

  // Discord-Action ausführen
  try {
    if (action === 'timeout') {
      const member = await interaction.guild.members.fetch(target.id);
      await member.timeout(durationMs, reason);
    } else if (action === 'kick') {
      const member = await interaction.guild.members.fetch(target.id);
      await member.kick(reason);
    } else if (action === 'ban') {
      await interaction.guild.bans.create(target.id, { reason, deleteMessageSeconds: 0 });
    } else {
      console.warn('applyEscalation: unknown action', action);
      return null;
    }
  } catch (err) {
    await postEscalationFailEmbed({ interaction, target, action, durationMs, threshold, err });
    console.warn(`applyEscalation ${action} failed for guild ${guildId}, user ${target.id}:`, err);
    return null;
  }

  // Case schreiben
  let caseNumber;
  try {
    const result = await cases.createCase({
      guildId,
      userId: target.id,
      moderatorId: interaction.client.user.id,
      type: action,
      reason,
      durationMs,
      expiresAt: durationMs ? new Date(Date.now() + durationMs) : null,
      source: 'escalation',
    });
    caseNumber = result.caseNumber;
  } catch (err) {
    console.error(`applyEscalation: createCase failed after successful Discord action — STATE DRIFT for guild ${guildId}, user ${target.id}:`, err);
    await postEscalationFailEmbed({
      interaction, target, action, durationMs, threshold,
      err: new Error('Case-Schreibung fehlgeschlagen (Discord-Action wurde durchgeführt)'),
    });
    return null;
  }

  // Erfolgs-Mod-Log-Embed posten
  try {
    const modLogChannelId = await config.getModLogChannelId(guildId).catch(() => null);
    if (modLogChannelId) {
      const modLogChannel = await interaction.client.channels.fetch(modLogChannelId).catch(() => null);
      if (modLogChannel) {
        const embed = buildModLogEmbed({
          action,
          caseNumber,
          target,
          mod: interaction.client.user,
          reason,
          durationMs,
        });
        if (embed) {
          await modLogChannel.send({ embeds: [embed] }).catch((e) =>
            console.warn('[escalation] modlog send failed', e?.code || e),
          );
        }
      }
    }
  } catch (err) {
    console.warn('applyEscalation modlog post failed:', err);
  }

  return { caseNumber, action };
}

/**
 * Postet einen Fail-Embed in den Mod-Log-Channel ohne Case zu schreiben.
 * Wird bei Discord-Action-Failure oder Case-Schreibungs-Failure aufgerufen.
 * Best-effort: wenn auch dieser Post scheitert, nur console.warn.
 */
async function postEscalationFailEmbed({ interaction, target, action, durationMs, threshold, err }) {
  try {
    const modLogChannelId = await config.getModLogChannelId(interaction.guildId).catch(() => null);
    if (!modLogChannelId) return;
    const modLogChannel = await interaction.client.channels.fetch(modLogChannelId).catch(() => null);
    if (!modLogChannel) return;

    const actionLabel = action === 'timeout' && durationMs
      ? `${action} (${formatDuration(durationMs)})`
      : action;

    const failEmbed = new EmbedBuilder()
      .setTitle('⚠️ Auto-Eskalation fehlgeschlagen')
      .setColor(0xfaa61a)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '👤 Target', value: `<@${target.id}>`, inline: false },
        { name: '🎯 Geplante Action', value: actionLabel, inline: false },
        { name: '🔢 Bei Schwelle', value: `${threshold} aktive Warns`, inline: true },
        { name: '❌ Grund', value: String(err?.message ?? err).slice(0, 900), inline: false },
      )
      .setFooter({ text: '🐾 Oreo' })
      .setTimestamp();

    await modLogChannel.send({ embeds: [failEmbed] });
  } catch (postErr) {
    console.warn('postEscalationFailEmbed itself failed:', postErr);
  }
}
```

Then add `applyEscalation` to the `module.exports` block:

```js
module.exports = {
  getRuleForThreshold,
  listRules,
  setRule,
  removeRule,
  applyEscalation,
};
```

`postEscalationFailEmbed` is intentionally NOT exported — internal helper.

- [ ] **Step 2: Wire up in `src/commands/warn.js`**

Add to imports at the top of `src/commands/warn.js`, after `const { buildModLogEmbed } = require('../modlog');`:

```js
const escalations = require('../escalations');
```

Then find the end of the `execute` function — the mod-log post try/catch block ends around line 117 with:

```js
    } catch (err) {
      console.warn('ModLog send failed:', err);
      await interaction.followUp({
        content: 'Mod-Log-Eintrag fehlgeschlagen — Channel-Permission oder Channel-ID prüfen.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
```

Insert the escalation step BEFORE the closing `},` of `execute` (i.e., after the mod-log catch closes):

```js
    // 5. Stage 3: Auto-Eskalation (best-effort)
    try {
      const activeWarnCount = await cases.countActiveWarnings(interaction.guildId, target.id);
      await escalations.applyEscalation({ interaction, target, activeWarnCount });
    } catch (err) {
      console.warn('Escalation failed:', err);
    }
  },
};
```

`cases` is already imported (see top of warn.js — `const cases = require('../cases');`).

The outer try/catch protects against `countActiveWarnings` failures; `applyEscalation` has its own internal fail-soft handling.

- [ ] **Step 3: Verify by smoke-loading both modules**

```powershell
node --env-file=.env -e "const e = require('./src/escalations'); const w = require('./src/commands/warn'); console.log('escalations exports:', Object.keys(e).join(',')); console.log('warn execute:', typeof w.execute);"
```

Expected output:
```
escalations exports: getRuleForThreshold,listRules,setRule,removeRule,applyEscalation
warn execute: function
```

If module loading throws, fix the syntax error before continuing.

- [ ] **Step 4: Re-run all existing smoke tests (regression check)**

```powershell
node tests/smoke/modlog.js
node --env-file=.env tests/smoke/duration.js
node --env-file=.env tests/smoke/reports.js
node --env-file=.env tests/smoke/escalations.js
```

Expected: all four exit 0 with `OK`-lines or `✓ alle ... passed`. Task 3 doesn't touch DAL or other helpers, but the import-graph change could surface a circular-require if there's a bug.

- [ ] **Step 5: Commit**

```powershell
git add src/escalations.js src/commands/warn.js
git commit -m @'
feat(escalations): applyEscalation + /warn wire-up

src/escalations.js gewinnt applyEscalation: prueft Rule fuer
threshold = activeWarnCount, fuehrt Discord-Action (timeout/kick/ban)
aus, schreibt Auto-Case mit source=escalation, postet Mod-Log-Embed
via buildModLogEmbed. Discord- oder Case-Failure → eigener
"Auto-Eskalation fehlgeschlagen"-Embed (kein Case).

/warn ruft escalations.applyEscalation nach dem Mod-Log-Post. Aussere
try/catch schuetzt gegen DB-Failure beim countActiveWarnings.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 4: `/config escalation` Subcommand-Group + `/config show` Integration

**Files:**
- Modify: `src/commands/config.js` (extend slash-command-builder, add 3 handlers + `/config show` integration)

This task is the largest single-file change (~130 LoC) but the additions are well-scoped: a new subcommand-group definition + a switch-arm in the execute dispatcher + 3 handler functions + a new section in `handleShow`.

- [ ] **Step 1: Add imports if missing**

`src/commands/config.js` currently imports (top of file):
- `SlashCommandBuilder`, `MessageFlags`, `EmbedBuilder`, `PermissionFlagsBits`, `ChannelType` from `discord.js`
- `getPool` from `../db`
- `config` from `../config`

Add these new imports near the existing ones:

```js
const escalations = require('../escalations');
const { parseDuration, formatDuration, MAX_TIMEOUT_MS } = require('../duration');
```

Verify they're not already present — search for `escalations` and `parseDuration` in the file first. Skip the line if already imported.

- [ ] **Step 2: Add slash-builder subcommand-group**

In the `data: new SlashCommandBuilder()` chain, after the existing `feature` subcommand-group (around line 73-79), add a new `.addSubcommandGroup` call. The exact location: between the `feature` group's closing `)` and the `.addSubcommand((sub) => sub.setName('show')...` line (which is the `/config show` top-level subcommand).

Insert:

```js
    .addSubcommandGroup((group) =>
      group.setName('escalation').setDescription('Auto-Eskalations-Regeln')
        .addSubcommand((sub) =>
          sub.setName('set').setDescription('Setzt oder aktualisiert eine Eskalations-Regel.')
            .addIntegerOption((o) => o.setName('warn_threshold').setDescription('Aktive Warn-Anzahl bei der die Regel feuert (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
            .addStringOption((o) => o.setName('action').setDescription('Action').setRequired(true).addChoices(
              { name: 'timeout', value: 'timeout' },
              { name: 'kick', value: 'kick' },
              { name: 'ban', value: 'ban' },
            ))
            .addStringOption((o) => o.setName('duration').setDescription('Dauer (nur bei timeout) — z.B. 30m, 2h, 7d').setRequired(false))
        )
        .addSubcommand((sub) =>
          sub.setName('unset').setDescription('Entfernt eine Eskalations-Regel.')
            .addIntegerOption((o) => o.setName('warn_threshold').setDescription('Aktive Warn-Anzahl der zu entfernenden Regel (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
        )
        .addSubcommand((sub) =>
          sub.setName('list').setDescription('Zeigt alle konfigurierten Eskalations-Regeln.')
        )
    )
```

- [ ] **Step 3: Add dispatch arms in the `execute` function**

Find the existing `execute` function's dispatch logic. It uses `interaction.options.getSubcommandGroup(false)` and `interaction.options.getSubcommand(false)`. Find the existing branch handling for `'feature'` or `'channel'` groups — add a parallel branch for `'escalation'`.

Add to the dispatch (near the other group dispatches; exact location: in the switch/if-chain that handles `'role'`, `'channel'`, `'feature'`):

```js
    if (group === 'escalation') {
      if (sub === 'set') return handleEscalationSet(interaction);
      if (sub === 'unset') return handleEscalationUnset(interaction);
      if (sub === 'list') return handleEscalationList(interaction);
    }
```

**No per-subcommand tier-gating needed.** The `/config` command has `requiredTier: 'owner'` at module level (line ~85), gating ALL subcommands (including `escalation list`) to owner-tier. This matches existing behavior for `/config show`, `/config role list`, etc. — supporters cannot run any `/config` subcommand. The K12 test in Task 5 confirms this implicitly.

- [ ] **Step 4: Add the three handler functions**

Add these three handlers AFTER the existing `handleFeatureSet` function (or wherever the `feature`-group handlers live; group escalation handlers together):

```js
const ACTION_ICON = { timeout: '⏱️', kick: '👢', ban: '🔨' };
const MAX_ESCALATION_RULES_IN_SHOW = 5;

async function handleEscalationSet(interaction) {
  const threshold = interaction.options.getInteger('warn_threshold');
  const action = interaction.options.getString('action');
  const durationInput = interaction.options.getString('duration');

  let durationMinutes = null;
  let durationDisplay = null;
  let ignoredDurationWarning = false;

  if (action === 'timeout') {
    if (!durationInput) {
      return interaction.reply({
        content: '❌ Dauer ist für `action:timeout` erforderlich. Beispiel: `30m`, `2h`, `7d`.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const durationMs = parseDuration(durationInput);
    if (durationMs == null) {
      return interaction.reply({
        content: '❌ Ungültige Dauer-Angabe.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (durationMs < 60_000) {
      return interaction.reply({
        content: '❌ Min. Timeout-Dauer ist 1 Minute.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (durationMs > MAX_TIMEOUT_MS) {
      return interaction.reply({
        content: '❌ Maximale Timeout-Dauer ist 28 Tage.',
        flags: MessageFlags.Ephemeral,
      });
    }
    durationMinutes = Math.floor(durationMs / 60_000);
    durationDisplay = formatDuration(durationMs);
  } else if (durationInput) {
    // kick or ban: duration ignored
    ignoredDurationWarning = true;
  }

  try {
    await escalations.setRule(interaction.guildId, threshold, action, durationMinutes);
  } catch (err) {
    console.error('/config escalation set DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const icon = ACTION_ICON[action] ?? '';
  const actionLabel = durationDisplay ? `${icon} ${capitalize(action)} ${durationDisplay}` : `${icon} ${capitalize(action)}`;
  let message = `✅ Eskalation gesetzt: bei ${threshold} aktiven Warns → ${actionLabel}`;
  if (ignoredDurationWarning) {
    message += `\n⚠️ Dauer wird bei \`${action}\` ignoriert.`;
  }
  return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}

async function handleEscalationUnset(interaction) {
  const threshold = interaction.options.getInteger('warn_threshold');
  let affected = 0;
  try {
    affected = await escalations.removeRule(interaction.guildId, threshold);
  } catch (err) {
    console.error('/config escalation unset DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const message = affected > 0
    ? `✅ Eskalation für Schwelle ${threshold} entfernt.`
    : `Keine Eskalation für Schwelle ${threshold} konfiguriert — nichts zu tun.`;
  return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}

async function handleEscalationList(interaction) {
  let rules = [];
  try {
    rules = await escalations.listRules(interaction.guildId);
  } catch (err) {
    console.error('/config escalation list DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('🎯 Eskalations-Regeln')
    .setColor(0x5865f2)
    .setFooter({ text: '🐾 Oreo' })
    .setTimestamp();

  if (rules.length === 0) {
    embed.setDescription('Keine Eskalations-Regeln konfiguriert. Setze welche mit `/config escalation set`.');
  } else {
    embed.setDescription(rules.map(formatRuleLine).join('\n'));
  }

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

function formatRuleLine(rule) {
  const icon = ACTION_ICON[rule.action] ?? '';
  const threshold = Number(rule.warn_threshold);
  if (rule.action === 'timeout' && rule.duration_minutes) {
    const durMs = Number(rule.duration_minutes) * 60_000;
    return `• Schwelle ${threshold} → ${icon} Timeout ${formatDuration(durMs)}`;
  }
  return `• Schwelle ${threshold} → ${icon} ${capitalize(rule.action)}`;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
```

Note: `capitalize` and `formatRuleLine` are new helpers — confirmed via grep that neither exists in `config.js` today.

- [ ] **Step 5: Integrate into `/config show`**

`handleShow` in `src/commands/config.js` currently builds the embed with this `addFields` block (around line 567):

```js
    .addFields(
      { name: '📺 Channels',     value: `Report: ${reportLine}\nMod-Log: ${modlogLine}`, inline: false },
      { name: '⚙️ Features',     value: `Automod: ${automodLine}`,                       inline: false },
      { name: '📊 Statistiken',  value: `Nächste Case-Nr: ${nextCase}`,                  inline: false },
      { name: '🔐 Rollen-Tiers', value: rolesValue,                                       inline: false },
    )
```

**Add a new "🎯 Eskalation" field between `⚙️ Features` and `📊 Statistiken`.** Two parts:

(a) BEFORE the `EmbedBuilder` construction (after `rolesValue` is computed around line 562), add the data fetch + value-build:

```js
  // Stage 3: Eskalations-Regeln für show
  let escalationRules = [];
  try {
    escalationRules = await escalations.listRules(interaction.guildId);
  } catch (err) {
    console.warn('handleShow: listRules failed', err);
    // fail-soft: zeige show ohne Eskalations-Section
  }

  let escalationValue;
  if (escalationRules.length === 0) {
    escalationValue = 'keine Regeln gesetzt';
  } else {
    const shown = escalationRules.slice(0, MAX_ESCALATION_RULES_IN_SHOW).map(formatRuleLine);
    const overflow = escalationRules.length - MAX_ESCALATION_RULES_IN_SHOW;
    if (overflow > 0) shown.push(`... +${overflow} weitere`);
    escalationValue = shown.join('\n');
  }
```

(b) UPDATE the `addFields(...)` block — insert the new field-entry between `Features` and `Statistiken`:

```js
    .addFields(
      { name: '📺 Channels',     value: `Report: ${reportLine}\nMod-Log: ${modlogLine}`, inline: false },
      { name: '⚙️ Features',     value: `Automod: ${automodLine}`,                       inline: false },
      { name: '🎯 Eskalation',   value: escalationValue,                                  inline: false },
      { name: '📊 Statistiken',  value: `Nächste Case-Nr: ${nextCase}`,                  inline: false },
      { name: '🔐 Rollen-Tiers', value: rolesValue,                                       inline: false },
    )
```

- [ ] **Step 6: Smoke-load `config.js`**

```powershell
node --env-file=.env -e "const c = require('./src/commands/config'); console.log('config loaded:', typeof c.execute);"
```

Expected: `config loaded: function`. No syntax errors.

- [ ] **Step 7: Run all smoke tests for regression**

```powershell
node tests/smoke/modlog.js
node --env-file=.env tests/smoke/duration.js
node --env-file=.env tests/smoke/reports.js
node --env-file=.env tests/smoke/escalations.js
```

Expected: all four pass. The /config command tests don't exist (Stage 2b never added one), but the existing smoke tests should be unaffected by these changes.

- [ ] **Step 8: Redeploy slash commands**

The bot's slash-builder structure has changed (new subcommand-group). Discord needs the new structure pushed.

If your bot is running via Docker:
```powershell
docker compose --project-directory "c:/Users/Lukas/Documents/Oreo" restart bot
```

The bot's `index.js` typically deploys commands at startup. Watch the log:
```powershell
docker compose --project-directory "c:/Users/Lukas/Documents/Oreo" logs bot --tail 30
```

Expected log lines:
- `Deployed N command(s) to guild ...` (N may have increased by 0 because `/config` count stays at 1 — but the underlying command JSON has more subcommand-groups)
- `Logged in as Oreo#...`

- [ ] **Step 9: Commit**

```powershell
git add src/commands/config.js
git commit -m @'
feat(config): add /config escalation set/unset/list subgroup

Erweitert /config um Eskalations-Verwaltung:
- /config escalation set warn_threshold:N action:X [duration:D]
- /config escalation unset warn_threshold:N
- /config escalation list

Validierung: timeout braucht duration (1min - 28d), kick/ban
ignoriert duration mit Warning. Owner-tier gated wie andere
mutierende /config-Subcommands.

/config show bekommt neue "Eskalation"-Section. Bei >5 Rules
wird "+N weitere" Suffix angezeigt.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 5: Manual E2E + Push

**No code changes.** Pure verification step + push.

- [ ] **Step 1: Confirm clean working tree + bot running with latest code**

```powershell
git -C "c:/Users/Lukas/Documents/Oreo" status
docker compose --project-directory "c:/Users/Lukas/Documents/Oreo" ps
docker compose --project-directory "c:/Users/Lukas/Documents/Oreo" logs bot --tail 30
```

Expected: clean working tree (or only the same unstaged files that existed before this stage). MySQL + bot both running. Bot log shows `Deployed N command(s)` + `Logged in as Oreo#...`.

If the bot is running stale code, rebuild:
```powershell
docker compose --project-directory "c:/Users/Lukas/Documents/Oreo" up -d --build bot
```

- [ ] **Step 2: Configuration tests (K1–K12 from spec §6.2)**

Work through the checklist in `docs/superpowers/specs/2026-06-03-stage3-escalation-rules-design.md` §6.2 "Konfiguration-Tests":

- [ ] K1: `/config escalation set warn_threshold:3 action:timeout duration:30m` → ✅
- [ ] K2: `/config escalation list` → Embed mit Schwelle 3 + 30 Minuten
- [ ] K3: `/config escalation set warn_threshold:3 action:kick` (UPSERT) → ✅
- [ ] K4: `/config escalation list` → Schwelle 3 mit kick (no duration)
- [ ] K5: `/config escalation set warn_threshold:5 action:timeout duration:garbage` → ❌ "Ungültige Dauer"
- [ ] K6: `/config escalation set warn_threshold:5 action:timeout duration:30t` → ❌ "Max. 28 Tage"
- [ ] K7: `/config escalation set warn_threshold:5 action:timeout` (no duration) → ❌ "Dauer erforderlich"
- [ ] K8: `/config escalation set warn_threshold:5 action:kick duration:30m` → ✅ + "Dauer ignoriert"-Warning, list zeigt kick ohne duration
- [ ] K9: `/config escalation unset warn_threshold:5` → ✅
- [ ] K10: `/config escalation unset warn_threshold:999` → "Keine Eskalation — nichts zu tun"
- [ ] K11: `/config show` → enthält 🎯 Eskalation-Section
- [ ] K12: Supporter-Account: `/config escalation set ...` → Permission denied

- [ ] **Step 3: Auto-escalation tests (E1–E7b)**

Setup: rule für `warn_threshold:3 action:timeout duration:5m`. Use a test-target user. Aim for these state transitions:

- [ ] E1: `/warn @target g1` → count=1, no auto-action
- [ ] E2: `/warn @target g2` → count=2, no auto-action
- [ ] E3: `/warn @target g3` → count=3, **Auto-Timeout fires.** 2 embeds in mod-log: normal warn + auto-timeout with `Moderator: @Oreo`, `Grund: Auto-Eskalation (Schwelle: 3 aktive Warns)`. Target is timed-out for 5m.
- [ ] E4: `/case <auto-case-N>` → shows `Quelle: escalation`, `Moderator: @Oreo`
- [ ] E5: `/warn @target g4` → count=4, no auto-action (no rule for 4)
- [ ] E6: `/removewarn <warn1-case>` → count=3, no auto-action (decrement doesn't fire)
- [ ] E7: `/removewarn <warn2-case>` → count=2, no auto-action
- [ ] E7b: `/warn @target g5` → count=3 again → **Auto-Timeout fires AGAIN** (re-fire confirmed)

- [ ] **Step 4: Failure tests (F1–F3)**

- [ ] F1: Remove bot's `ModerateMembers` permission temporarily. Configure threshold=3 with timeout. `/warn @target` until count=3 → "⚠️ Auto-Eskalation fehlgeschlagen" embed with Permission-related reason, **no** new auto-case. Restore the permission after.
- [ ] F2: Target leaves server. Try to drive their count to 3 (may require pre-existing warns or a fresh target who joined-then-left). Auto-action fires → fail-Embed "User nicht (mehr) im Server".
- [ ] F3: Configure rule action=ban. Target has higher role than bot. `/warn` drives target to threshold → fail-Embed "Target hat höhere Rolle" (or similar Discord-error reason). Note: this is tricky because the warner needs to be ≥ target in role hierarchy to issue the warn in the first place. Use an owner-warner against a moderator-target where the moderator has a role above the bot.

- [ ] **Step 5: Out-of-scope verification (X1–X4)**

- [ ] X1: `/timeout @target 1h test` → no escalation trigger (timeout-command isn't a warn)
- [ ] X2: After E3 (target has auto-timeout case), `/removewarn` the trigger-warn → auto-case stays active (no rollback)
- [ ] X3: `/reason <case> new text` → no escalation trigger
- [ ] X4: Owner /warns themselves up to threshold=3 → fail-embed "höhere Rolle" (bot can't act on owner)

- [ ] **Step 6: Confirm clean working tree**

```powershell
git -C "c:/Users/Lukas/Documents/Oreo" status
```

Expected: clean tree (or only the same pre-existing unstaged items from before Stage 3 — same state as the start of this plan).

- [ ] **Step 7: Push**

```powershell
git -C "c:/Users/Lukas/Documents/Oreo" push origin main
```

Expected: 4 Stage-3 commits land on origin (Task 1, 2, 3, 4 commits) plus the plan's own commit when written.

---

## Out-of-Scope Reminders (do NOT do these in this plan)

Per Spec §1 and §7:

- No reverse-escalation when `/removewarn` decreases the count (auto-cases stay)
- No per-user/per-role escalation exempt-list
- No time-window for warn decay (only `active=1` counts)
- No tempban (`ban` is permanent; `duration_minutes` ignored for ban)
- No retry-queue for failed Discord actions
- No `/config escalation toggle` (use unset)
- No rule-history / audit-log
- No per-channel rules
- No bot-permission preview on `/config escalation set action:ban` (admin must know bot has BanMembers)
- No multiple-action rules ("DM + timeout")
- No escalation on `/timeout`, `/kick`, `/ban`, `/removewarn`, `/reason` triggers
- No automod migration to escalation (Stage 4 is separate)

---

## Self-Review Trace

**Spec coverage:**
| Spec section | Covered by |
|---|---|
| §1 Ziel & Scope | All Tasks 1–5 |
| §2.1 Schema migration | Task 1 |
| §2.2 Modul-Layout | Tasks 2 + 3 (escalations.js), Task 4 (config.js) |
| §2.3 escalations.js API | Task 2 (DAL), Task 3 (applyEscalation) |
| §3.1 /warn wire-up | Task 3 Step 2 |
| §3.2 applyEscalation steps | Task 3 Step 1 |
| §3.3 Discord-failure-branch | Task 3 Step 1 (postEscalationFailEmbed) |
| §3.4 Mod-log success-embed | Task 3 Step 1 (buildModLogEmbed call) |
| §3.5 cases.createCase source param | Pre-existing (no task needed; already accepts source) |
| §4 /config escalation subcommand-group | Task 4 |
| §4.1 slash-builder structure | Task 4 Step 2 |
| §4.2 set validation | Task 4 Step 4 (handleEscalationSet) |
| §4.3 unset | Task 4 Step 4 (handleEscalationUnset) |
| §4.4 list | Task 4 Step 4 (handleEscalationList) |
| §4.5 /config show integration | Task 4 Step 5 |
| §5 Edge-cases | Task 3 Step 1 (impl), Task 5 (E2E tests F1–F3, X1–X4) |
| §6.1 Smoke-test | Task 2 Step 1 |
| §6.2 Manual E2E | Task 5 Steps 2–5 |
| §6.3 Rollback | Implicit per task (additive schema, isolated commits) |
| §7 Open Questions | Out-of-scope list above |
| §8 File-Plan-Summary | File Plan section above |

**Placeholder scan:**
- No "TBD" / "TODO" / "implement later"
- No "add appropriate error handling" without specifics
- No "Similar to Task N" — each task has its own code
- `capitalize` is defined inline in Task 4; "reuse if exists" note flags duplication risk
- The "verification before continuing" note in Task 4 Step 3 (about tier-gating) is a genuine "read existing pattern first" — not a placeholder

**Type/identifier consistency:**
- `escalations.getRuleForThreshold(guildId, threshold)` — Task 2 (impl), Task 3 (caller in applyEscalation) match
- `escalations.setRule(guildId, threshold, action, durationMinutes)` — Task 2 (impl), Task 4 (caller in handleEscalationSet) match
- `escalations.removeRule(guildId, threshold)` — Task 2 (impl), Task 4 (handleEscalationUnset) match
- `escalations.listRules(guildId)` — Task 2 (impl), Task 4 (handleEscalationList + handleShow) match
- `escalations.applyEscalation({interaction, target, activeWarnCount})` — Task 3 (impl), Task 3 (caller in warn.js) match
- `cases.createCase({source: 'escalation', ...})` — pre-existing param contract, Task 3 uses it
- `cases.countActiveWarnings(guildId, userId)` — pre-existing function, Task 3 uses it
- Source ENUM value `'escalation'` — Task 1 (schema), Task 3 (createCase call) match
- Field name `🎯 Eskalation` — Task 4 Step 5 (/config show) consistent with Task 4 Step 4 (list embed title)
- Action icons `{timeout: '⏱️', kick: '👢', ban: '🔨'}` — Task 4 ACTION_ICON constant, used in handleEscalationSet's reply + formatRuleLine
- Constants `MAX_ESCALATION_RULES_IN_SHOW = 5`, `MAX_TIMEOUT_MS` (imported from duration.js) — consistently named/sourced
