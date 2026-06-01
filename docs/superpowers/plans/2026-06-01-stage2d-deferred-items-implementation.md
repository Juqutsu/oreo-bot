# Stage 2d Deferred-Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the three deferred items from Stage 2c spec §11 — central `src/modlog.js` embed factory (all 5 producers migrated), `/case <N>` reverse-lookup to the originating report, and a `/config channel set type:report` permission-check that warns about moderator+ roles without `View Channel`.

**Architecture:** Single new module (`src/modlog.js`, pure builder), one DB index migration (`idx_resolution_case`), one new DAL function (`reports.getReportByCaseNumber`), and inline additions to `/case` and `/config` handlers. No new commands, no breaking schema changes.

**Tech Stack:** Node.js 20.6+ (`--env-file` flag), discord.js v14, mysql2/promise, plain JS, no transpiler. Smoke-tests in `tests/smoke/*.js` run via `node --env-file=.env tests/smoke/<file>.js`.

**Spec:** `docs/superpowers/specs/2026-06-01-stage2d-deferred-items-design.md`

---

## File Plan

```
NEU
├── src/modlog.js                                  (Task 2)
└── tests/smoke/modlog.js                          (Task 2)

GEÄNDERT
├── server/schema.sql                              (Task 1, +5 LoC migration block)
├── src/commands/warn.js                           (Task 3, inline embed → buildModLogEmbed)
├── src/commands/timeout.js                        (Task 3)
├── src/commands/kick.js                           (Task 3)
├── src/commands/ban.js                            (Task 3)
├── src/interactions/report.js                     (Task 3, lokale helper-function entfernt)
├── src/reports.js                                 (Task 4, + getReportByCaseNumber + export)
├── tests/smoke/reports.js                         (Task 4, + getReportByCaseNumber test)
├── src/commands/case.js                           (Task 4, + Reverse-Lookup block)
└── src/commands/config.js                         (Task 5, + collectReportPermWarnings + warning-block)
```

**Task order rationale:**
- Task 1 first: index needed by Task 4's reverse-lookup query.
- Task 2 second: `src/modlog.js` must exist before Task 3's migrators import it.
- Task 3 third: migrate all 5 producers in one commit (mechanical refactor, single coherent diff).
- Task 4 fourth: pure additive feature, independent of Tasks 2/3.
- Task 5 fifth: also pure additive, independent.
- Task 6 last: whole-branch manual E2E + push.

---

## Task 1: Schema-Migration — `idx_resolution_case` Index

**Files:**
- Modify: `server/schema.sql:146` (append new Stage-2d migration block after Stage-2c ALTER block)

**Why:** `reports.getReportByCaseNumber(guildId, caseNumber)` (Task 4) filters by `WHERE guild_id = ? AND resolution_case_number = ?`. No index on `resolution_case_number` exists today (Stage 2c added `idx_dup_check` and `idx_open_per_guild`, but neither covers this lookup). Without the index, MySQL does a full-table-scan per `/case` invocation.

- [ ] **Step 1: Inspect current end-of-file**

Read the last 10 lines of `server/schema.sql` to find the right append point. The Stage-2c migration block ends with the `idx_dup_check` ADD INDEX statement on line 146. Append after that.

- [ ] **Step 2: Append migration block**

Add to the very end of `server/schema.sql`:

```sql

-- ============================================================
-- Stage 2d Migration: /case Reverse-Lookup Index
-- ============================================================
-- Speedup für reports.getReportByCaseNumber(guildId, caseNumber).
-- Idempotent via schema-runner (errno 1061 swallowed in src/schema.js).

ALTER TABLE reports ADD INDEX idx_resolution_case (guild_id, resolution_case_number);
```

- [ ] **Step 3: Run schema migration against the live MySQL**

The bot uses Docker Compose. Schema is applied via `src/schema.js` runner, which is invoked at bot startup (and can be triggered standalone).

Run:
```powershell
node --env-file=.env -e "require('./src/schema').ensureSchema().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})"
```

Expected console output contains either:
- `[schema] Applied: ALTER TABLE reports ADD INDEX idx_resolution_case ...` (first run)
- `[schema] Skipped duplicate index (errno 1061): ...idx_resolution_case...` (idempotent re-run)

If the bot is already running, the migration also auto-runs at next restart. Either trigger is sufficient.

- [ ] **Step 4: Verify the index exists**

Run:
```powershell
docker compose exec mysql mysql -u root -p${env:MYSQL_ROOT_PASSWORD} oreo -e "SHOW INDEX FROM reports WHERE Key_name = 'idx_resolution_case';"
```

Expected: row with `Key_name = idx_resolution_case`, columns `guild_id` (seq 1) + `resolution_case_number` (seq 2).

If credentials env-var differs, use `${env:MYSQL_PASSWORD}` or `${env:DATABASE_PASSWORD}` accordingly — check `.env` first.

- [ ] **Step 5: Idempotency check (re-run schema)**

Run the migration command from Step 3 a second time. Expected: log message contains "Skipped duplicate index" (errno 1061). No error throw, process exits 0.

- [ ] **Step 6: Commit**

```powershell
git add server/schema.sql
git commit -m @'
feat(schema): Stage 2d add idx_resolution_case on reports

Speedup für /case <N> reverse-lookup via
reports.getReportByCaseNumber(guildId, caseNumber). Index covers
(guild_id, resolution_case_number). Idempotent via schema-runner.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 2: `src/modlog.js` + Smoke Test

**Files:**
- Create: `src/modlog.js`
- Create: `tests/smoke/modlog.js`

**TDD-Reihenfolge:** Smoke-Test first, lass ihn fehlschlagen (Module existiert nicht), dann implementiere bis grün.

- [ ] **Step 1: Write the failing smoke test**

Create `tests/smoke/modlog.js`:

```js
// Smoke-Test für src/modlog.js — kein DB-Zugriff, kein Discord-Client.
// Konvention: ausführen mit `node tests/smoke/modlog.js` (keine --env-file nötig).

const assert = require('node:assert/strict');
const { buildModLogEmbed } = require('../../src/modlog');

console.log('==== src/modlog.js smoke-test ====');

// Test-Doubles: target/mod mit minimaler GuildMember/User-Shape
const stubUser = (id, name) => ({
  id,
  username: name,
  displayAvatarURL: () => `https://cdn.discord.example/${id}.png`,
});

const target = stubUser('111', 'TargetUser');
const mod = stubUser('222', 'ModUser');

// 1. action=warn, mit caseNumber
{
  const embed = buildModLogEmbed({
    action: 'warn',
    caseNumber: 7,
    target,
    mod,
    reason: 'Spam',
  });
  const data = embed.toJSON();
  assert.equal(data.title, '⚠️ User verwarnt');
  assert.equal(data.color, 0xfaa61a);
  assert.equal(data.fields.length, 3, 'warn: 3 fields ohne dmFailed');
  assert.equal(data.fields[0].name, '👤 User');
  assert.equal(data.fields[0].value, '<@111>');
  assert.equal(data.fields[1].name, '🛡️ Moderator');
  assert.equal(data.fields[2].name, '📝 Grund');
  assert.equal(data.fields[2].value, 'Spam');
  assert.equal(data.footer.text, 'Case #7 · 🐾');
  assert.ok(data.timestamp, 'timestamp gesetzt');
  console.log('✓ action=warn (no dmFailed)');
}

// 2. action=warn, dmFailed=true
{
  const embed = buildModLogEmbed({
    action: 'warn',
    caseNumber: 7,
    target,
    mod,
    reason: 'Spam',
    dmFailed: true,
  });
  const data = embed.toJSON();
  assert.equal(data.fields.length, 4, 'warn: 4 fields mit dmFailed');
  assert.equal(data.fields[3].name, '📬 DM');
  assert.equal(data.fields[3].value, 'Nicht zugestellt (DMs aus?)');
  console.log('✓ action=warn (dmFailed=true)');
}

// 3. action=timeout
{
  const embed = buildModLogEmbed({
    action: 'timeout',
    caseNumber: 8,
    target,
    mod,
    reason: 'Trolling',
    durationMs: 60000,
  });
  const data = embed.toJSON();
  assert.equal(data.title, '⏱️ Timeout vergeben');
  assert.equal(data.color, 0xfaa61a);
  assert.equal(data.fields.length, 5);
  assert.equal(data.fields[0].name, 'User');
  assert.equal(data.fields[0].value, '<@111>', 'kein (username)-Suffix mehr');
  assert.equal(data.fields[0].inline, true);
  assert.equal(data.fields[1].name, 'Moderator');
  assert.equal(data.fields[1].value, '<@222>');
  assert.equal(data.fields[2].name, 'Grund');
  assert.equal(data.fields[3].name, 'Dauer');
  assert.equal(data.fields[4].name, 'Läuft ab');
  console.log('✓ action=timeout');
}

// 4. action=kick
{
  const embed = buildModLogEmbed({
    action: 'kick',
    caseNumber: 9,
    target, mod, reason: 'Regelbruch',
  });
  const data = embed.toJSON();
  assert.equal(data.title, 'User gekickt');
  assert.equal(data.color, 0xed4245);
  assert.equal(data.fields.length, 3);
  console.log('✓ action=kick');
}

// 5. action=ban
{
  const embed = buildModLogEmbed({
    action: 'ban',
    caseNumber: 10,
    target, mod, reason: 'NSFW',
  });
  const data = embed.toJSON();
  assert.equal(data.title, '🔨 User gebannt');
  assert.equal(data.color, 0xed4245);
  console.log('✓ action=ban');
}

// 6. action=unknown → null
{
  const result = buildModLogEmbed({
    action: 'mystery', caseNumber: 1, target, mod, reason: '',
  });
  assert.equal(result, null, 'unbekannte action → null');
  console.log('✓ action=unknown → null');
}

// 7. caseNumber=null → fallback footer
{
  const embed = buildModLogEmbed({
    action: 'warn', caseNumber: null, target, mod, reason: 'x',
  });
  const data = embed.toJSON();
  assert.equal(data.footer.text, 'Case-Eintrag fehlgeschlagen · 🐾');
  console.log('✓ caseNumber=null → fallback footer');
}

// 8. reason=null → "Kein Grund angegeben"
{
  const embed = buildModLogEmbed({
    action: 'warn', caseNumber: 1, target, mod, reason: null,
  });
  const data = embed.toJSON();
  assert.equal(data.fields[2].value, 'Kein Grund angegeben');
  console.log('✓ reason=null → fallback text');
}

console.log('✓ alle modlog-smoke-tests passed');
```

- [ ] **Step 2: Run test, verify failure**

Run:
```powershell
node tests/smoke/modlog.js
```

Expected: `Error: Cannot find module '../../src/modlog'` — confirms TDD-red state.

- [ ] **Step 3: Implement `src/modlog.js`**

Create `src/modlog.js`:

```js
const { EmbedBuilder } = require('discord.js');
const { formatDuration } = require('./duration');

const COLOR_WARN = 0xfaa61a;
const COLOR_TIMEOUT = 0xfaa61a;
const COLOR_KICK = 0xed4245;
const COLOR_BAN = 0xed4245;

function buildModLogEmbed({
  action,
  caseNumber,
  target,
  mod,
  reason,
  durationMs,
  dmFailed = false,
}) {
  const footer = caseNumber
    ? `Case #${caseNumber} · 🐾`
    : 'Case-Eintrag fehlgeschlagen · 🐾';
  const reasonValue = reason ?? 'Kein Grund angegeben';

  if (action === 'warn') {
    const embed = new EmbedBuilder()
      .setTitle('⚠️ User verwarnt')
      .setColor(COLOR_WARN)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '👤 User', value: `<@${target.id}>`, inline: false },
        { name: '🛡️ Moderator', value: `<@${mod.id}>`, inline: false },
        { name: '📝 Grund', value: reasonValue, inline: false },
      );
    if (dmFailed) {
      embed.addFields({ name: '📬 DM', value: 'Nicht zugestellt (DMs aus?)', inline: false });
    }
    return embed.setFooter({ text: footer }).setTimestamp();
  }

  if (action === 'timeout') {
    const expSec = Math.floor((Date.now() + durationMs) / 1000);
    return new EmbedBuilder()
      .setTitle('⏱️ Timeout vergeben')
      .setColor(COLOR_TIMEOUT)
      .setThumbnail(target.displayAvatarURL({ dynamic: true }))
      .addFields(
        { name: 'User', value: `<@${target.id}>`, inline: true },
        { name: 'Moderator', value: `<@${mod.id}>`, inline: true },
        { name: 'Grund', value: reasonValue, inline: false },
        { name: 'Dauer', value: formatDuration(durationMs), inline: true },
        { name: 'Läuft ab', value: `<t:${expSec}:f>`, inline: true },
      )
      .setFooter({ text: footer })
      .setTimestamp();
  }

  if (action === 'kick') {
    return new EmbedBuilder()
      .setTitle('User gekickt')
      .setColor(COLOR_KICK)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '👤 User', value: `<@${target.id}>`, inline: false },
        { name: '🛡️ Moderator', value: `<@${mod.id}>`, inline: false },
        { name: '📝 Grund', value: reasonValue, inline: false },
      )
      .setFooter({ text: footer })
      .setTimestamp();
  }

  if (action === 'ban') {
    return new EmbedBuilder()
      .setTitle('🔨 User gebannt')
      .setColor(COLOR_BAN)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '👤 User', value: `<@${target.id}>`, inline: false },
        { name: '🛡️ Moderator', value: `<@${mod.id}>`, inline: false },
        { name: '📝 Grund', value: reasonValue, inline: false },
      )
      .setFooter({ text: footer })
      .setTimestamp();
  }

  return null;
}

module.exports = { buildModLogEmbed };
```

- [ ] **Step 4: Run test, verify pass**

Run:
```powershell
node tests/smoke/modlog.js
```

Expected: 8 `✓` lines, ending with `✓ alle modlog-smoke-tests passed`. Exit code 0.

- [ ] **Step 5: Commit**

```powershell
git add src/modlog.js tests/smoke/modlog.js
git commit -m @'
feat(modlog): central mod-log embed factory + smoke test

src/modlog.js exports buildModLogEmbed({action, caseNumber, target,
mod, reason, durationMs, dmFailed}) returning an EmbedBuilder for
warn/timeout/kick/ban or null for unknown action. Canonical layout
matches the Stage-2c interactions/report.js variant. dmFailed
optional (only warn uses it today).

tests/smoke/modlog.js verifies all 4 actions + edge-cases offline
(no DB, no Discord client).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 3: Migrate All 5 Producers to `src/modlog.js`

**Files:**
- Modify: `src/commands/warn.js` (inline embed → `buildModLogEmbed` call)
- Modify: `src/commands/timeout.js`
- Modify: `src/commands/kick.js`
- Modify: `src/commands/ban.js`
- Modify: `src/interactions/report.js` (lokale `buildModLogEmbed` ersetzen durch Import)

**Note:** All 5 migrations land in ONE commit. They're a single coherent refactor — no behavior change except `timeout.js` losing the `(${target.username})` suffix in User/Mod fields (per spec §3.4, documented bewusst).

- [ ] **Step 1: warn.js — replace inline embed builder**

In `src/commands/warn.js`:

1. Add at top (next to `const cases = require('../cases');`):
   ```js
   const { buildModLogEmbed } = require('../modlog');
   ```

2. Find the `try { const channelId = await config.getModLogChannelId(...)` block (around line 90). Inside the block, replace the inline `EmbedBuilder` construction (lines ~101–115, ending at `.setTimestamp();`) with:
   ```js
   const modEmbed = buildModLogEmbed({
     action: 'warn',
     caseNumber,
     target,
     mod: moderator,
     reason: reasonForDisplay,
     dmFailed,
   });
   await logChannel.send({ embeds: [modEmbed] });
   ```

3. Keep the `try/catch` and `followUp` boilerplate above and below — only the embed-build code is replaced.

4. Remove the now-unused `EmbedBuilder` import IF it's no longer used elsewhere in the file. **Check:** `warn.js` still builds a separate DM-embed (`dmEmbed`) which uses `EmbedBuilder` — keep the import.

- [ ] **Step 2: timeout.js — replace inline embed builder**

In `src/commands/timeout.js`:

1. Add import:
   ```js
   const { buildModLogEmbed } = require('../modlog');
   ```

2. In the mod-log `try`-block (around line 133), replace the entire `const embed = new EmbedBuilder()...` chain (lines ~143–155) with:
   ```js
   const embed = buildModLogEmbed({
     action: 'timeout',
     caseNumber,
     target,
     mod: moderator,
     reason,
     durationMs,
   });
   await logChannel.send({ embeds: [embed] });
   ```

3. **`mod` parameter:** all four mod-commands declare `const moderator = interaction.member;` (verified — `moderator` is `GuildMember`). `GuildMember.id` and `GuildMember.displayAvatarURL()` both exist, so `mod: moderator` works as-is. No `.user` indirection needed.

4. Remove unused `formatDuration` import from `timeout.js` IF nothing else uses it. (`timeout.js` likely still uses `formatDuration(durationMs)` for the interaction.reply message — verify before removal.) Run:
   ```powershell
   Select-String -Path src/commands/timeout.js -Pattern "formatDuration"
   ```
   Keep the import if any other usage remains.

- [ ] **Step 3: kick.js — replace inline embed builder**

In `src/commands/kick.js`:

1. Add import: `const { buildModLogEmbed } = require('../modlog');`

2. In the mod-log `try`-block (around line 80), replace the `const modEmbed = new EmbedBuilder()...` chain with:
   ```js
   const modEmbed = buildModLogEmbed({
     action: 'kick',
     caseNumber,
     target,
     mod: moderator,
     reason,
   });
   await logChannel.send({ embeds: [modEmbed] });
   ```

3. Remove `EmbedBuilder` import if no other use remains (`kick.js` may not have other embed-builds). Check:
   ```powershell
   Select-String -Path src/commands/kick.js -Pattern "EmbedBuilder"
   ```

- [ ] **Step 4: ban.js — replace inline embed builder**

Identical pattern to kick.js. In `src/commands/ban.js`:

1. Add: `const { buildModLogEmbed } = require('../modlog');`

2. Replace the inline embed in the mod-log try-block with:
   ```js
   const modEmbed = buildModLogEmbed({
     action: 'ban',
     caseNumber,
     target,
     mod: moderator,
     reason,
   });
   await logChannel.send({ embeds: [modEmbed] });
   ```

3. Remove `EmbedBuilder` import if unused.

- [ ] **Step 5: interactions/report.js — replace local helper with import**

In `src/interactions/report.js`:

1. Add to imports (next to the other `require('./...')` lines, e.g. after `const { getPool } = require('../db');`):
   ```js
   const { buildModLogEmbed } = require('../modlog');
   ```

2. Delete the entire local `function buildModLogEmbed({ action, caseNumber, target, mod, reason, durationMs }) { ... }` definition (lines ~113–177). Remove also the now-redundant comment-block immediately above it if any.

3. The usage-site at line ~469 (inside `handleModalResolve` step 8) already calls `buildModLogEmbed({ action, caseNumber, target: targetUser, mod: interaction.user, reason, durationMs })` — no change needed there.

4. Verify `formatDuration` import is still needed in this file for other purposes (e.g., resolve-action display in modal flow). Run:
   ```powershell
   Select-String -Path src/interactions/report.js -Pattern "formatDuration"
   ```
   Keep import if used elsewhere; remove only if the deleted helper was the sole user.

- [ ] **Step 6: Run all smoke tests**

Run:
```powershell
node tests/smoke/modlog.js
node --env-file=.env tests/smoke/duration.js
node --env-file=.env tests/smoke/reports.js
```

Expected: all three exit 0 with `✓`-lines. The modlog-test doesn't touch DB; reports.js test requires `.env` for MySQL connection.

If `tests/smoke/reports.js` fails for unrelated reasons (DB not running etc.), that's not a regression of this task — but document and move on. Tests for modlog.js itself must pass.

- [ ] **Step 7: Sanity-check — no orphaned imports**

Run:
```powershell
Select-String -Path src/commands/warn.js,src/commands/timeout.js,src/commands/kick.js,src/commands/ban.js,src/interactions/report.js -Pattern "EmbedBuilder" -SimpleMatch
```

Expected: zero or few hits — only legitimate remaining uses (e.g., warn.js's DM-embed). No `require('discord.js')` line should import `EmbedBuilder` if the file no longer uses it.

- [ ] **Step 8: Lint-style check — duplicate hex colors**

The `0xfaa61a` and `0xed4245` hex constants should be GONE from the 5 migrated files (they live now in `src/modlog.js`). Verify:
```powershell
Select-String -Path src/commands/warn.js,src/commands/timeout.js,src/commands/kick.js,src/commands/ban.js,src/interactions/report.js -Pattern "0xfaa61a|0xed4245"
```

Acceptable matches: 
- `src/interactions/report.js` — the `COLOR_DISMISSED = 0xED4245` constant for report-embed-state colors (different purpose, keep).
- `src/commands/warn.js` — the DM-embed uses `0xfaa61a` (separate embed, keep).
- `src/commands/warnings.js` (not in this list) — that's `/warnings` listing command, untouched.

If you see the constant inside a mod-log embed-build code path → not fully migrated, fix.

- [ ] **Step 9: Commit**

```powershell
git add src/modlog.js src/commands/warn.js src/commands/timeout.js src/commands/kick.js src/commands/ban.js src/interactions/report.js
git commit -m @'
refactor(modlog): migrate 5 producers to src/modlog.js

warn.js, timeout.js, kick.js, ban.js, and interactions/report.js
now import buildModLogEmbed from src/modlog.js instead of building
their own EmbedBuilder. Canonical layout matches Stage 2c.

Sichtbare Änderung: timeout-Mod-Log-Embed verliert den
"(${target.username})"-Suffix in User/Moderator fields (Spec §3.4).
Andere 4 Producer: keine sichtbare Änderung.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 4: `/case <N>` Reverse-Lookup

**Files:**
- Modify: `src/reports.js:89-99` (add `getReportByCaseNumber` + export)
- Modify: `tests/smoke/reports.js` (add integration test for new function)
- Modify: `src/commands/case.js:1-3` (add `reports` require) and `:78-80` (add reverse-lookup field)

- [ ] **Step 1: Write failing smoke-test for `getReportByCaseNumber`**

Open `tests/smoke/reports.js` and find the existing test sequence. After the last existing test (likely `resolveReport`), add:

The existing test script already creates a report, claims it, and resolves it with `caseNumber: 42` (see lines ~26–58). Add the new test block immediately after that `resolveReport` call (before any cleanup-DELETE at the end of `main()`):

```js
  // --- getReportByCaseNumber (Stage 2d) ---
  const found = await reports.getReportByCaseNumber(GUILD, 42);
  assert.ok(found, 'reverse-lookup findet den Report');
  assert.equal(String(found.id), String(reportId));
  assert.equal(String(found.reporter_id), REPORTER);
  assert.equal(String(found.reported_user_id), TARGET);
  console.log('✓ getReportByCaseNumber findet Report via case_number=42');

  const notFound = await reports.getReportByCaseNumber(GUILD, 0);
  assert.equal(notFound, null, 'unbekannte case_number → null');
  console.log('✓ getReportByCaseNumber liefert null bei unbekannter case_number');
```

Uses the existing variables `GUILD`, `REPORTER`, `TARGET`, `reportId` from the test script. No new setup needed because Stage-2c already builds a complete report→claim→resolve sequence ahead of this point.

- [ ] **Step 2: Run test, verify failure**

Run:
```powershell
node --env-file=.env tests/smoke/reports.js
```

Expected: `TypeError: reports.getReportByCaseNumber is not a function`.

- [ ] **Step 3: Implement `getReportByCaseNumber` in `src/reports.js`**

Find the existing function block (just before `module.exports = { ... }` on line 89). Add this function above the exports:

```js
/**
 * Sucht den Report, dessen Resolve-Aktion in einen bestimmten Case geflossen ist.
 * Genutzt von /case <N> für die Reverse-Lookup-Anzeige (Stage 2d Spec §4.1).
 *
 * @param {string} guildId
 * @param {number} caseNumber
 * @returns {Promise<object|null>} { id, reporter_id, reported_user_id, created_at, message_id } oder null
 */
async function getReportByCaseNumber(guildId, caseNumber) {
  const [rows] = await getPool().execute(
    `SELECT id, reporter_id, reported_user_id, created_at, message_id
       FROM reports
      WHERE guild_id = ? AND resolution_case_number = ?
      LIMIT 1`,
    [guildId, caseNumber],
  );
  return rows[0] ?? null;
}
```

- [ ] **Step 4: Add to `module.exports`**

In `src/reports.js:89`, extend the exports block to include the new function. Append `getReportByCaseNumber,` immediately after `COOLDOWN_MS,` (or at the end before the closing brace):

```js
module.exports = {
  createReport,
  attachMessageId,
  getReport,
  hasOpenReportFromTo,
  claimReport,
  resolveReport,
  dismissReport,
  checkCooldown,
  touchCooldown,
  COOLDOWN_MS,
  getReportByCaseNumber,
};
```

- [ ] **Step 5: Run test, verify pass**

Run:
```powershell
node --env-file=.env tests/smoke/reports.js
```

Expected: all existing tests pass + new `✓ getReportByCaseNumber findet Report via case_number` and `✓ getReportByCaseNumber liefert null bei unbekannter Nummer` lines.

- [ ] **Step 6: Integrate in `/case` command**

Open `src/commands/case.js`. At the top, after `const cases = require('../cases');`, add:

```js
const reports = require('../reports');
```

Then find the block (around line 72) that ends with:
```js
if (c.parent_case_number) {
  embed.addFields({ name: '🔗 Bezogen auf', value: `Case #${c.parent_case_number}`, inline: true });
}
```

Directly **after** that block (and before the `if (c.duration_ms)` block), insert:

```js
// Stage 2d: Reverse-Lookup auf Report-Quelle (Spec §4.3)
let linkedReport = null;
try {
  linkedReport = await reports.getReportByCaseNumber(interaction.guildId, c.case_number);
} catch (err) {
  console.warn('getReportByCaseNumber failed:', err);
  // fail-soft: zeige Case ohne Quelle-Info
}
if (linkedReport) {
  embed.addFields({
    name: '🚨 Quelle',
    value: `Report #${linkedReport.id} von <@${linkedReport.reporter_id}>`,
    inline: false,
  });
}
```

- [ ] **Step 7: Smoke-check the change doesn't crash on load**

Run:
```powershell
node --env-file=.env -e "const c = require('./src/commands/case'); console.log('case command loaded:', typeof c.execute)"
```

Expected: `case command loaded: function`. No syntax errors, no import errors.

- [ ] **Step 8: Commit**

```powershell
git add src/reports.js tests/smoke/reports.js src/commands/case.js
git commit -m @'
feat(case): reverse-lookup zum Report bei /case <N>

reports.getReportByCaseNumber(guildId, caseNumber) liefert die
Reporter-Identität + Report-ID, wenn ein Case via Report-Resolve
entstanden ist. /case fügt das als "🚨 Quelle: Report #M von
<@reporter>" Field hinzu (ab supporter+ Tier sichtbar).

Bewusster Override von Stage-2c §6.5 Anonymitätsregel — dokumentiert
in Stage-2d Spec §4.4.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 5: `/config channel set type:report` Permission-Check

**Files:**
- Modify: `src/commands/config.js:284` (`handleChannelSet` function)

- [ ] **Step 1: Add `collectReportPermWarnings` helper**

In `src/commands/config.js`, add the helper function above `async function handleChannelSet(...)`. Confirm the imports at the top of the file already include `PermissionFlagsBits`, `getPool`, etc. — if any is missing, add it (`getPool` likely already imported, `PermissionFlagsBits` definitely already used in `handleChannelSet`).

```js
const MAX_ROLES_IN_PERM_WARNING = 10;

/**
 * Sammelt moderator+ Rollen, die das angegebene Channel nicht sehen können.
 * Liefert leeres Array bei keinen Blockern oder DB/Discord-Fehler (fail-soft).
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildChannel} channel
 * @returns {Promise<string[]>} Array von Role-IDs (string)
 */
async function collectReportPermWarnings(guild, channel) {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT role_id FROM role_permissions
       WHERE guild_id = ? AND permission IN ('moderator', 'owner')`,
    [guild.id],
  );

  const blocked = [];
  for (const { role_id } of rows) {
    const roleIdStr = String(role_id);
    const role = guild.roles.cache.get(roleIdStr)
      ?? await guild.roles.fetch(roleIdStr).catch(() => null);
    if (!role) continue; // Rolle gelöscht → silent skip
    const perms = channel.permissionsFor(role);
    if (!perms || !perms.has(PermissionFlagsBits.ViewChannel)) {
      blocked.push(role.id);
    }
  }
  return blocked;
}
```

- [ ] **Step 2: Integrate check into `handleChannelSet`**

In `handleChannelSet` (around line 284), after the existing `EmbedLinks`-check block (which ends with the `return interaction.reply({ content: '...EmbedLinks fehlt...' })` `if`-block around line 313), and BEFORE the `const column = CHANNEL_COLUMN[type];` line, insert:

```js
  // Stage 2d: Report-Channel Permission-Check (Spec §5)
  let permissionWarnings = [];
  if (type === 'report') {
    try {
      permissionWarnings = await collectReportPermWarnings(interaction.guild, channel);
    } catch (err) {
      console.warn('collectReportPermWarnings failed:', err);
      // fail-soft: kein Warning, Channel-Set läuft weiter
    }
  }
```

- [ ] **Step 3: Extend success reply to include warning**

Find the existing 3-branch reply at the end of `handleChannelSet`:

```js
  let message;
  if (previousId === channel.id) {
    message = `Channel \`${label}\` war bereits <#${channel.id}>.`;
  } else if (previousId) {
    message = `Channel \`${label}\` von <#${previousId}> auf <#${channel.id}> geändert.`;
  } else {
    message = `Channel \`${label}\` gesetzt auf <#${channel.id}>.`;
  }

  return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
```

Replace the `return interaction.reply(...)` line with a block that appends the warning when applicable. Keep the 3-branch `message` logic intact:

```js
  if (permissionWarnings.length > 0) {
    const shown = permissionWarnings.slice(0, MAX_ROLES_IN_PERM_WARNING).map(id => `<@&${id}>`).join(', ');
    const overflow = permissionWarnings.length - MAX_ROLES_IN_PERM_WARNING;
    const rolesList = overflow > 0 ? `${shown}, +${overflow} weitere` : shown;
    message += `\n\n⚠️ Achtung: Folgende Mod-Rollen können den Channel nicht sehen: ${rolesList}\nBitte \`View Channel\`-Permission setzen, sonst sehen sie keine eingehenden Reports.`;
  }

  return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
```

The warning-block is only triggered when `type === 'report'` AND there are blocked roles (Task 5 Step 2 ensures `permissionWarnings = []` for non-report types and DB/Discord errors).

- [ ] **Step 4: Smoke-check the file loads**

Run:
```powershell
node --env-file=.env -e "const c = require('./src/commands/config'); console.log('config loaded:', typeof c.execute)"
```

Expected: `config loaded: function`. No syntax errors.

- [ ] **Step 5: Run all smoke tests to confirm no regression**

Run:
```powershell
node tests/smoke/modlog.js
node --env-file=.env tests/smoke/duration.js
node --env-file=.env tests/smoke/reports.js
node --env-file=.env tests/smoke/config.js
```

Expected: all four exit 0. The config smoke test (if it exists from Stage 2b) should still pass — this task adds logic to `handleChannelSet` but doesn't change its existing happy-path return shape.

If `tests/smoke/config.js` does NOT exist, skip it (Stage 2b may have only done manual E2E for config) and document the skip.

- [ ] **Step 6: Commit**

```powershell
git add src/commands/config.js
git commit -m @'
feat(config): warn on mod-tier roles without ViewChannel on report-channel

/config channel set type:report now scans role_permissions for
moderator+ tiers and appends a warning to the success reply listing
any roles that lack ViewChannel on the target channel. Warn-only —
channel is still set. Caps at 10 roles shown with "+X weitere".

Out-of-scope per Spec §5: type:mod_log not checked, supporter tier
not checked, member-overrides not considered.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

## Task 6: Manual E2E + Final Whole-Branch Review + Push

**No code changes.** Pure verification step.

- [ ] **Step 1: Confirm clean working tree**

Run:
```powershell
git status
```

Expected: nothing staged, nothing modified (apart from the pre-existing unstaged `src/commands/config.js` comment-removal diff that's not part of Stage 2d — leave or address separately).

- [ ] **Step 2: Confirm bot is running with new code**

Restart the bot:
```powershell
docker compose restart bot
docker compose logs bot --tail 30
```

Expected log lines:
- `[schema] Skipped duplicate index (errno 1061)` (if index was created in Task 1) OR no schema errors
- `Bot logged in as ...`

- [ ] **Step 3: Run manual E2E checklist from Spec §6.2**

Open the spec at `docs/superpowers/specs/2026-06-01-stage2d-deferred-items-design.md` and work through every checkbox in §6.2:

**Modlog-Refactor (Smoke-Check):**
- [ ] `/warn @user test` → Mod-Log shows `⚠️ User verwarnt` embed
- [ ] `/timeout @user 5m test` → Mod-Log embed, User/Moderator fields ohne `(username)`-Suffix
- [ ] `/kick @user test` (owner) → Mod-Log `User gekickt` embed
- [ ] `/ban @user test` (owner) → Mod-Log `🔨 User gebannt` embed
- [ ] `/report` → claim → resolve → Warn → Mod-Log embed unchanged from Stage 2c E2E

**/case Reverse-Lookup:**
- [ ] `/report` einen User → moderator claimt → resolved mit Warn → Case-Nummer N notieren
- [ ] `/case N` als moderator → Embed zeigt `🚨 Quelle: Report #M von <@reporter>`
- [ ] `/case N` als supporter → gleicher Embed
- [ ] `/warn @user direkt` → `/case N+1` → kein Quelle-Field

**Perm-Check:**
- [ ] Neue Mod-Rolle `@TestMod`, in `#reports` `View Channel` deny
- [ ] `/config role set role:@TestMod tier:moderator` (oder Stage-2a-Äquivalent — `/config role set` Subcommand)
- [ ] `/config channel set type:report channel:#reports` → Reply enthält Warning mit `<@&TestMod>`
- [ ] View Channel allow → erneut `/config channel set` → Reply ohne Warning
- [ ] `/config channel set type:mod_log channel:#mod-log` mit blockiertem `@TestMod` → Reply ohne Warning (out-of-scope)
- [ ] `@TestMod` löschen, `/config channel set type:report ...` erneut → kein Crash, silent skip

**Acceptance:** every box ticked. Any failure → file a follow-up bug-fix task before push.

- [ ] **Step 4: Whole-branch review (optional but recommended)**

If using subagent-driven-development, the controlling session dispatches a final code-review subagent over the commits made in Tasks 1–5. Reviewer scope: `git log main..HEAD` since the start of Stage 2d (i.e., commits after `b301207 docs(specs): Stage 2d deferred-items design` and `dd85ace fix(specs): ...`).

If executing inline: human review of the 5 new commits.

Pass/fail criteria:
- Spec coverage verified for every section
- No new ESLint/runtime warnings introduced
- No regression in existing smoke tests

- [ ] **Step 5: Push to origin**

After E2E + review pass:
```powershell
git push origin main
```

Expected: 5 new commits land on origin (Task 1, 2, 3, 4, 5 commits) plus the two spec/plan commits (`b301207`, `dd85ace`, plus this plan's own commit when written).

---

## Out-of-Scope Reminders (do NOT do these in this plan)

- No `postModLog(client, guildId, embed)` Pipeline-Helper (Stage 2e Tech-Debt)
- No `mod_log`-Channel Permission-Check (only `report`-Channel)
- No klickbare `/case` Quelle-Field (just text "Report #M")
- No `untimeout`/`unban`/`removewarn`/`reason_edited` migration to modlog.js
- No automatic cleanup of orphaned `role_permissions` rows
- No layout-configurability per guild

All per Spec §2 and §8.

---

## Self-Review Trace

**Spec coverage:**
| Spec section | Covered by |
|---|---|
| §1 Ziel | All Tasks 1–6 |
| §2 Out-of-Scope | Documented in plan Out-of-Scope section above |
| §3 src/modlog.js — API & Layouts | Task 2 (Implementation + test), Task 3 (migration) |
| §3.1 Signatur | Task 2 Step 3 |
| §3.2 Kanonische Layouts | Task 2 Step 3 (alle 4 actions implementiert) |
| §3.3 Migration (5 Producer) | Task 3 Steps 1–5 |
| §3.4 Sichtbare Änderungen | Task 3 Step 9 (commit message documents the timeout-suffix removal) |
| §3.5 Was NICHT im Modul | Task 2 Step 3 (kein channel-fetch, kein send, kein untimeout etc.) |
| §4 /case Reverse-Lookup | Task 4 alle Steps |
| §4.1 DAL-Ergänzung | Task 4 Steps 3–5 |
| §4.2 Schema-Migration | Task 1 alle Steps |
| §4.3 /case-Embed-Integration | Task 4 Step 6 |
| §4.4 Anonymitäts-Spec-Update | Task 4 Step 8 (commit message), Spec selbst |
| §4.5 Fail-soft | Task 4 Step 6 (`try/catch` around DAL call) |
| §5 /config Perm-Check | Task 5 alle Steps |
| §5.1 Trigger-Bedingung | Task 5 Step 2 (`if type === 'report'`, after EmbedLinks check) |
| §5.2 Logik + Helper | Task 5 Steps 1–2 |
| §5.3 Reply-Format | Task 5 Step 3 |
| §5.4 Längenkontrolle | Task 5 Step 3 (`MAX_ROLES_IN_PERM_WARNING`, slice + overflow) |
| §5.5 Edge-Cases | Task 5 Step 1 (silent skip deleted role), Step 2 (fail-soft try/catch) |
| §5.6 Was NICHT geprüft | Documented in commit message Task 5 Step 6 + Out-of-Scope section |
| §6.1 Smoke-Tests | Task 2 Steps 1+4 (modlog), Task 4 Steps 1+5 (reports.getReportByCaseNumber), Task 5 Step 5 (run-all) |
| §6.2 Manuelle E2E | Task 6 Step 3 (full checklist) |
| §7 Rollback | Documented per task (additive only — no destructive change) |
| §8 Open Questions | Out-of-Scope section above |
| §9 File-Plan-Summary | File Plan section above |

**Placeholder scan:** No "TBD", "TODO", "implement later", or stub-only steps remain. The `mod: moderator` vs `mod: moderator.user` ambiguity in Task 3 is resolved via Step 2.4 (`Select-String`-check before-the-fact). No vague "add validation" or "handle edge cases" without code.

**Type/identifier consistency:**
- `buildModLogEmbed({action, caseNumber, target, mod, reason, durationMs, dmFailed})` — Task 2, Task 3 (alle 5 Caller) match
- `reports.getReportByCaseNumber(guildId, caseNumber)` — Task 4 Step 3 (impl), Step 1 (test), Step 6 (call from case.js) match
- Index name `idx_resolution_case` — Task 1 (create), Task 4 Step 3 (implicitly used by query)
- Table `role_permissions`, column `permission` — Task 5 Step 1 query matches schema verified in spec §5.2
- `MAX_ROLES_IN_PERM_WARNING = 10` — Task 5 Step 1 (define) + Step 3 (use) match
- Field-Position `🚨 Quelle` nach `🔗 Bezogen auf` — Task 4 Step 6 inserts at correct anchor
