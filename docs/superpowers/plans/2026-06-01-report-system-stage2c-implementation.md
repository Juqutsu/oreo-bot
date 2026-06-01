# Stage 2c Report-System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the /report user-facing reporting feature with interactive embed (Übernehmen/Resolve/Verwerfen), select-menu→modal Resolve flow, automatic Infraction-Case creation, and per-guild Report-Channel persistence.

**Architecture:** Slash command in `src/commands/report.js` delegates DB work to a new service module `src/reports.js`. A new `src/interactions/report.js` houses all button/select/modal handlers and exports a dispatcher that `index.js` calls for non-slash interactions. `parseDuration`/`MAX_TIMEOUT_MS` are extracted from `src/commands/timeout.js` into a shared `src/duration.js` helper because both `/timeout` and Resolve→Timeout need them. DB migration adds two columns (`resolution_case_number`, `message_id`) and a dup-check index to the existing Stage 1 `reports` table — idempotent ALTERs via existing `ER_DUP_FIELDNAME`/`ER_DUP_KEYNAME` catch in `src/schema.js`.

**Tech Stack:** Node.js, discord.js v14, mysql2/promise, Docker MySQL 8.x. Spec: `docs/superpowers/specs/2026-06-01-report-system-stage2c-design.md`.

---

## File Plan

**Create:**
- `src/duration.js` — exports `parseDuration(input)` and `MAX_TIMEOUT_MS`
- `src/reports.js` — DB layer + cooldown map for reports
- `src/commands/report.js` — `/report` slash command
- `src/interactions/report.js` — button/select/modal handlers + `dispatch(interaction)`
- `tests/smoke/reports.js` — smoke-test script
- `tests/smoke/duration.js` — smoke-test for the extracted duration helper

**Modify:**
- `server/schema.sql` — append ALTER TABLE reports + new INDEX
- `src/schema.js` — catch ER_DUP_KEYNAME (1061) so the ADD INDEX is idempotent
- `src/commands/timeout.js` — replace inline `parseDuration`/`MAX_TIMEOUT_MS` with require from `src/duration.js`
- `index.js` — extend `InteractionCreate` handler to route non-slash interactions through report-dispatcher

**Not touched:** `src/perms.js`, `src/cases.js`, `src/config.js`, `src/db.js`, `src/loadCommands.js`, `src/deployCommands.js`, all other commands.

---

## Task 1: DB Migration — Idempotent ALTERs

**Files:**
- Modify: `server/schema.sql` (append ALTERs at file end)
- Modify: `src/schema.js` (extend error-code catch list to include ER_DUP_KEYNAME = 1061)
- Test: `tests/smoke/db-migration.sh` (Bash) — or run schema-loader and inspect DESCRIBE/SHOW INDEX manually

### Step-by-step

- [ ] **Step 1: Append ALTERs to `server/schema.sql`**

Add at end of file:

```sql
-- Stage 2c: report system extensions
ALTER TABLE reports ADD COLUMN resolution_case_number INT UNSIGNED NULL;
ALTER TABLE reports ADD COLUMN message_id BIGINT UNSIGNED NULL;
ALTER TABLE reports ADD INDEX idx_dup_check (guild_id, reporter_id, reported_user_id, status);
```

Each ALTER as its own statement (the loader splits on `;`).

- [ ] **Step 2: Inspect `src/schema.js` to find the existing error-catch block**

Run: `Grep ER_DUP_FIELDNAME -C 3 src/schema.js`

You should find a try/catch that swallows MySQL error 1060 (ER_DUP_FIELDNAME) for idempotent ADD COLUMN. We need to also swallow 1061 (ER_DUP_KEYNAME) for idempotent ADD INDEX.

- [ ] **Step 3: Extend the catch in `src/schema.js`**

If the existing catch looks like:

```js
} catch (e) {
  if (e?.errno === 1060) continue;  // ER_DUP_FIELDNAME: column already exists
  throw e;
}
```

Change it to:

```js
} catch (e) {
  if (e?.errno === 1060) continue;  // ER_DUP_FIELDNAME: column already exists
  if (e?.errno === 1061) continue;  // ER_DUP_KEYNAME: index already exists
  throw e;
}
```

(Adjust exact line/code to match what's there — read the file first.)

- [ ] **Step 4: Run schema loader and verify (Docker)**

Run: `docker compose up -d mysql` (skip if running), then `node -e "require('./src/schema').ensureSchema().then(() => { console.log('OK'); process.exit(0); }).catch(e => { console.error(e); process.exit(1); })"`

Expected: prints `OK` on first run.

- [ ] **Step 5: Verify the schema in MySQL**

Run: `docker exec -i $(docker compose ps -q mysql) mysql -uroot -proot oreo -e "DESCRIBE reports; SHOW INDEX FROM reports;"`

Expected: `DESCRIBE reports` shows columns `resolution_case_number` (int unsigned) and `message_id` (bigint unsigned). `SHOW INDEX FROM reports` lists key `idx_dup_check` over (guild_id, reporter_id, reported_user_id, status).

- [ ] **Step 6: Re-run loader to prove idempotency**

Run the same `node -e ...` command again.

Expected: still prints `OK`, no errors about duplicate column/key.

- [ ] **Step 7: Commit**

```bash
git add server/schema.sql src/schema.js
git commit -m "feat(schema): Stage 2c reports migration (resolution_case_number + message_id + dup-index)

Three additive ALTERs on the Stage 1 reports table to support the /report
system: resolution_case_number links the resolved report to the auto-created
Infraction-Case, message_id stores the Discord embed message ID for in-place
edits on state transitions, and idx_dup_check makes the (guild_id, reporter,
target, status) duplicate-check an index lookup.

src/schema.js now also catches ER_DUP_KEYNAME (1061) so the ADD INDEX is
idempotent — MySQL 8.x doesn't support IF NOT EXISTS for ADD INDEX (same
limitation as ADD COLUMN that we worked around in Stage 1.5)."
```

---

## Task 2: Extract `parseDuration` + `MAX_TIMEOUT_MS` to `src/duration.js`

**Files:**
- Create: `src/duration.js`
- Modify: `src/commands/timeout.js` (delete inline helper, require from new module)
- Test: `tests/smoke/duration.js`

### Step-by-step

- [ ] **Step 1: Read current `src/commands/timeout.js` to find the helper code**

Run: `Grep -n -B 1 -A 20 "function parseDuration" src/commands/timeout.js` and `Grep -n MAX_TIMEOUT_MS src/commands/timeout.js`

Identify the lines that contain:
- The `parseDuration(input)` function definition
- The `MAX_TIMEOUT_MS` constant (Discord max is 28 days = `28 * 24 * 60 * 60 * 1000`)
- `formatDuration(ms)` if it lives in the same file (it's referenced in the spec context)

Note the exact contents — you'll move them verbatim.

- [ ] **Step 2: Create `src/duration.js`**

Move the code into a new file:

```js
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

/**
 * Parses a duration string like "30s", "10m", "2h", "1t", "1w".
 * Returns milliseconds or null if invalid. "t" is German "Tag" (day).
 */
function parseDuration(input) {
  // PASTE the exact body from timeout.js here, unchanged.
}

/**
 * Formats milliseconds into a human-readable German duration string.
 */
function formatDuration(ms) {
  // PASTE the exact body from timeout.js here, unchanged.
}

module.exports = { parseDuration, formatDuration, MAX_TIMEOUT_MS };
```

If `formatDuration` is also in `timeout.js`, move it too — both `/timeout` and the Resolve→Timeout flow need to format the chosen duration for the embed.

- [ ] **Step 3: Create `tests/smoke/duration.js`**

```js
const { parseDuration, formatDuration, MAX_TIMEOUT_MS } = require('../../src/duration');
const assert = require('node:assert/strict');

assert.equal(parseDuration('30s'), 30_000, '30s → 30000 ms');
assert.equal(parseDuration('10m'), 10 * 60_000, '10m → 600000 ms');
assert.equal(parseDuration('2h'), 2 * 60 * 60_000, '2h → 7200000 ms');
assert.equal(parseDuration('1t'), 24 * 60 * 60_000, '1t → 86400000 ms (German Tag)');
assert.equal(parseDuration('1w'), 7 * 24 * 60 * 60_000, '1w → 604800000 ms');
assert.equal(parseDuration('garbage'), null, 'garbage → null');
assert.equal(parseDuration(''), null, 'empty → null');
assert.equal(MAX_TIMEOUT_MS, 28 * 24 * 60 * 60 * 1000, 'MAX_TIMEOUT_MS = 28 days');
assert.equal(typeof formatDuration(60_000), 'string', 'formatDuration returns string');
console.log('OK — duration smoke test passed');
```

- [ ] **Step 4: Run the smoke test BEFORE changing timeout.js**

Run: `node tests/smoke/duration.js`

Expected: `OK — duration smoke test passed`. If any assertion fails, the moved code differs from the original — fix the move.

- [ ] **Step 5: Update `src/commands/timeout.js`**

Delete the inline `parseDuration` / `formatDuration` / `MAX_TIMEOUT_MS` declarations. At the top, add:

```js
const { parseDuration, formatDuration, MAX_TIMEOUT_MS } = require('../duration');
```

(Adjust path: `src/commands/timeout.js` requires `../duration`.)

- [ ] **Step 6: Smoke-test `/timeout` still loads cleanly**

Run: `node -e "const t = require('./src/commands/timeout'); console.log(typeof t.execute === 'function' ? 'OK' : 'FAIL: execute missing'); console.log(typeof t.data.toJSON === 'function' ? 'OK' : 'FAIL: command builder broken')"`

Expected: two `OK` lines. No errors loading.

- [ ] **Step 7: Re-run the duration smoke test to ensure nothing regressed**

Run: `node tests/smoke/duration.js`

Expected: `OK — duration smoke test passed`

- [ ] **Step 8: Commit**

```bash
git add src/duration.js src/commands/timeout.js tests/smoke/duration.js
git commit -m "refactor(duration): extract parseDuration + MAX_TIMEOUT_MS to src/duration.js

Both /timeout and the upcoming Resolve→Timeout flow (Stage 2c report system)
need the same duration parser and the same 28-day discord max. Pulled the
helper out of src/commands/timeout.js into src/duration.js so both call
sites share a single source of truth instead of duplicating the regex.

Behavior unchanged. Smoke test covers German Tag suffix and the 28d cap."
```

---

## Task 3: `src/reports.js` Service Module + Smoke Test

**Files:**
- Create: `src/reports.js`
- Create: `tests/smoke/reports.js`

### Step-by-step

- [ ] **Step 1: Create `src/reports.js` skeleton**

```js
const { getPool } = require('./db');

const COOLDOWN_MS = 60_000;
const cooldown = new Map(); // userId (string) → epoch ms

async function createReport({ guildId, reporterId, reportedUserId, reason, evidenceUrl }) {
  const pool = getPool();
  const [result] = await pool.query(
    `INSERT INTO reports (guild_id, reporter_id, reported_user_id, reason, evidence_url, status)
     VALUES (?, ?, ?, ?, ?, 'open')`,
    [guildId, reporterId, reportedUserId, reason, evidenceUrl ?? null],
  );
  return result.insertId; // numeric BigInt from mysql2 with supportBigNumbers; coerce to string at boundary
}

async function attachMessageId(reportId, messageId) {
  const pool = getPool();
  await pool.query(`UPDATE reports SET message_id = ? WHERE id = ?`, [messageId, reportId]);
}

async function getReport(reportId, { forUpdate = false, conn = null } = {}) {
  const runner = conn ?? getPool();
  const sql = `SELECT * FROM reports WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`;
  const [rows] = await runner.query(sql, [reportId]);
  return rows[0] ?? null;
}

async function hasOpenReportFromTo(guildId, reporterId, reportedUserId) {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT 1 FROM reports
      WHERE guild_id = ? AND reporter_id = ? AND reported_user_id = ?
        AND status IN ('open','investigating')
      LIMIT 1`,
    [guildId, reporterId, reportedUserId],
  );
  return rows.length > 0;
}

async function claimReport(reportId, modId, { conn = null } = {}) {
  const runner = conn ?? getPool();
  await runner.query(
    `UPDATE reports SET status = 'investigating', assigned_mod_id = ? WHERE id = ?`,
    [modId, reportId],
  );
}

async function resolveReport(reportId, { modId, note, caseNumber, conn = null }) {
  const runner = conn ?? getPool();
  await runner.query(
    `UPDATE reports
       SET status = 'resolved',
           assigned_mod_id = ?,
           resolved_at = NOW(),
           resolution_note = ?,
           resolution_case_number = ?
     WHERE id = ?`,
    [modId, note ?? null, caseNumber ?? null, reportId],
  );
}

async function dismissReport(reportId, { modId, note, conn = null }) {
  const runner = conn ?? getPool();
  await runner.query(
    `UPDATE reports
       SET status = 'dismissed',
           assigned_mod_id = ?,
           resolved_at = NOW(),
           resolution_note = ?
     WHERE id = ?`,
    [modId, note ?? null, reportId],
  );
}

function checkCooldown(userId) {
  const last = cooldown.get(userId);
  if (!last) return 0;
  const remaining = COOLDOWN_MS - (Date.now() - last);
  return remaining > 0 ? remaining : 0;
}

function touchCooldown(userId) {
  cooldown.set(userId, Date.now());
}

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
  COOLDOWN_MS, // exported for tests
};
```

- [ ] **Step 2: Create `tests/smoke/reports.js`**

```js
const reports = require('../../src/reports');
const { getPool } = require('../../src/db');
const assert = require('node:assert/strict');

const GUILD = '999999999999999000'; // pure test guild id (will be inserted)
const REPORTER = '999999999999999001';
const TARGET = '999999999999999002';
const MOD = '999999999999999003';

async function main() {
  const pool = getPool();

  // Ensure parent guild row exists (FK constraint on reports.guild_id → guilds.guild_id)
  await pool.query(
    `INSERT INTO guilds (guild_id, next_case_number)
       VALUES (?, 1) ON DUPLICATE KEY UPDATE guild_id = guild_id`,
    [GUILD],
  );

  // Cleanup any old test rows
  await pool.query(`DELETE FROM reports WHERE guild_id = ?`, [GUILD]);

  // --- createReport ---
  const reportId = await reports.createReport({
    guildId: GUILD,
    reporterId: REPORTER,
    reportedUserId: TARGET,
    reason: 'Test report from smoke',
    evidenceUrl: 'https://example.com/proof',
  });
  assert.ok(reportId > 0, 'createReport returns a positive id');

  // --- getReport (no FOR UPDATE) ---
  const row = await reports.getReport(reportId);
  assert.equal(row.status, 'open', 'fresh report is open');
  assert.equal(row.reporter_id.toString(), REPORTER, 'reporter_id roundtrip');
  assert.equal(row.evidence_url, 'https://example.com/proof', 'evidence_url roundtrip');
  assert.equal(row.message_id, null, 'message_id starts NULL');

  // --- attachMessageId ---
  await reports.attachMessageId(reportId, '888888888888888001');
  const row2 = await reports.getReport(reportId);
  assert.equal(row2.message_id.toString(), '888888888888888001', 'message_id roundtrip');

  // --- hasOpenReportFromTo ---
  assert.equal(await reports.hasOpenReportFromTo(GUILD, REPORTER, TARGET), true, 'dup-check sees open report');
  assert.equal(await reports.hasOpenReportFromTo(GUILD, REPORTER, '999999999999999099'), false, 'dup-check misses unrelated target');

  // --- claimReport ---
  await reports.claimReport(reportId, MOD);
  const row3 = await reports.getReport(reportId);
  assert.equal(row3.status, 'investigating', 'claim → investigating');
  assert.equal(row3.assigned_mod_id.toString(), MOD, 'assigned_mod_id set');

  // --- resolveReport with caseNumber (Action ≠ None) ---
  await reports.resolveReport(reportId, { modId: MOD, note: 'spam — warned', caseNumber: 42 });
  const row4 = await reports.getReport(reportId);
  assert.equal(row4.status, 'resolved', 'resolve → resolved');
  assert.equal(row4.resolution_case_number, 42, 'caseNumber linked');
  assert.equal(row4.resolution_note, 'spam — warned', 'note saved');
  assert.ok(row4.resolved_at !== null, 'resolved_at set');

  // --- Second report for None-path + dismiss ---
  const reportId2 = await reports.createReport({
    guildId: GUILD,
    reporterId: REPORTER,
    reportedUserId: '999999999999999004',
    reason: 'Second test',
    evidenceUrl: null,
  });
  await reports.resolveReport(reportId2, { modId: MOD, note: null, caseNumber: null });
  const row5 = await reports.getReport(reportId2);
  assert.equal(row5.status, 'resolved', 'None-path also resolved');
  assert.equal(row5.resolution_case_number, null, 'None-path leaves caseNumber NULL');

  // --- dismissReport ---
  const reportId3 = await reports.createReport({
    guildId: GUILD,
    reporterId: REPORTER,
    reportedUserId: '999999999999999005',
    reason: 'Third test',
    evidenceUrl: null,
  });
  await reports.dismissReport(reportId3, { modId: MOD, note: 'duplicate' });
  const row6 = await reports.getReport(reportId3);
  assert.equal(row6.status, 'dismissed', 'dismiss → dismissed');
  assert.equal(row6.resolution_note, 'duplicate', 'dismiss-note saved');

  // --- Cooldown ---
  assert.equal(reports.checkCooldown(REPORTER), 0, 'cooldown initially 0');
  reports.touchCooldown(REPORTER);
  const r1 = reports.checkCooldown(REPORTER);
  assert.ok(r1 > 0 && r1 <= reports.COOLDOWN_MS, 'cooldown active and within window');
  await new Promise(r => setTimeout(r, 50));
  const r2 = reports.checkCooldown(REPORTER);
  assert.ok(r2 < r1, 'cooldown ticks down');

  // Cleanup
  await pool.query(`DELETE FROM reports WHERE guild_id = ?`, [GUILD]);
  await pool.query(`DELETE FROM guilds WHERE guild_id = ?`, [GUILD]);

  await pool.end();
  console.log('OK — reports smoke test passed');
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Make sure schema migration from Task 1 is applied**

Run: `node -e "require('./src/schema').ensureSchema().then(() => process.exit(0))"`

Expected: exits 0.

- [ ] **Step 4: Run the smoke test**

Run: `node tests/smoke/reports.js`

Expected: `OK — reports smoke test passed`. If FK errors on `guilds`, check that the smoke test inserts a guild row before the report row.

- [ ] **Step 5: Commit**

```bash
git add src/reports.js tests/smoke/reports.js
git commit -m "feat(reports): add DB service module + cooldown for Stage 2c

src/reports.js exposes createReport, attachMessageId, getReport (with
optional FOR UPDATE + caller-provided conn for transactions),
hasOpenReportFromTo for the duplicate-check, claimReport, resolveReport,
dismissReport, and an in-memory checkCooldown/touchCooldown map keyed by
userId with 60s window.

All write helpers accept an optional conn so the interaction handlers can
SELECT FOR UPDATE + UPDATE in a single transaction for race-safety. The
smoke test runs against the live MySQL container and covers all CRUD
paths plus the cooldown timing."
```

---

## Task 4: `/report` Slash Command

**Files:**
- Create: `src/commands/report.js`
- (Auto-registered via existing `src/loadCommands.js` + `src/deployCommands.js` IIFE in index.js)

### Step-by-step

- [ ] **Step 1: Verify the existing slash-command pattern**

Run: `Read src/commands/warn.js` (or any existing mod-command) — look for:
- The `module.exports = { data, requiredTier, execute }` shape
- How `data` is built (SlashCommandBuilder + addUserOption/addStringOption)
- How the execute pulls options and replies

Note: no `requiredTier` field means the loader's middleware skips the tier check (same as `/setup`). Confirm by reading `src/loadCommands.js`.

- [ ] **Step 2: Read how mod-commands build their initial Discord embed**

Run: `Grep -A 30 "EmbedBuilder" src/commands/warn.js | head -60`

This is the reference for the report embed style — keep colors, field-layout patterns consistent.

- [ ] **Step 3: Create `src/commands/report.js`**

```js
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const reports = require('../reports');
const config = require('../config');

const COLOR_OPEN = 0xFEE75C;

function buildOpenEmbed(reportId, reporter, target, reason, evidenceUrl, createdAtMs) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_OPEN)
    .setTitle(`🆕 Report #${reportId}`)
    .addFields(
      { name: 'Gemeldeter User', value: `${target} (${target.id})`, inline: true },
      { name: 'Reporter', value: `${reporter} (${reporter.id})`, inline: true },
      { name: 'Grund', value: reason },
    );
  if (evidenceUrl) {
    embed.addFields({ name: 'Evidence', value: `[Link](${evidenceUrl})` });
  }
  embed.addFields(
    { name: 'Status', value: '🟡 Offen', inline: true },
    { name: 'Eingegangen', value: `<t:${Math.floor(createdAtMs / 1000)}:R>`, inline: true },
  );
  return embed;
}

function buildOpenButtons(reportId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`report:claim:${reportId}`).setLabel('Übernehmen').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`report:resolve:${reportId}`).setLabel('Resolve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`report:dismiss:${reportId}`).setLabel('Verwerfen').setStyle(ButtonStyle.Danger),
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('report')
    .setDescription('Meldet einen User an die Moderation.')
    .setDMPermission(false)
    .addUserOption(o => o.setName('user').setDescription('Wer soll gemeldet werden?').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Was ist passiert? (max 500 Zeichen)').setRequired(true).setMaxLength(500))
    .addStringOption(o => o.setName('evidence_url').setDescription('Optional: Link zu Screenshot oder Nachricht').setRequired(false).setMaxLength(500)),

  // KEIN requiredTier — jeder Member darf reporten

  async execute(interaction) {
    const guildId = interaction.guildId;
    const reporter = interaction.user;
    const target = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason', true);
    const evidenceUrl = interaction.options.getString('evidence_url') ?? null;

    // 1a) report_channel configured?
    const channelId = await config.getReportChannelId(guildId);
    if (!channelId) {
      return interaction.reply({
        content: 'Report-System ist nicht aktiv. Bitte ein Admin: `/config channel set type:report channel:#...`',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 1b) self-report
    if (target.id === reporter.id) {
      return interaction.reply({ content: 'Du kannst dich nicht selbst melden.', flags: MessageFlags.Ephemeral });
    }

    // 1c) bot-report
    if (target.bot) {
      return interaction.reply({ content: 'Bots können nicht gemeldet werden.', flags: MessageFlags.Ephemeral });
    }

    // 1d) target on server?
    const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (!targetMember) {
      return interaction.reply({ content: 'User ist nicht (mehr) auf dem Server.', flags: MessageFlags.Ephemeral });
    }

    // 2) cooldown
    const remainingMs = reports.checkCooldown(reporter.id);
    if (remainingMs > 0) {
      return interaction.reply({
        content: `Bitte warte noch ${Math.ceil(remainingMs / 1000)}s vor dem nächsten Report.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // 3) duplicate
    const isDup = await reports.hasOpenReportFromTo(guildId, reporter.id, target.id);
    if (isDup) {
      return interaction.reply({
        content: 'Du hast bereits einen offenen Report gegen diesen User.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 4) evidence url shape
    if (evidenceUrl && !(evidenceUrl.startsWith('http://') || evidenceUrl.startsWith('https://'))) {
      return interaction.reply({
        content: 'Evidence muss mit http:// oder https:// beginnen.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 5) insert
    let reportId;
    try {
      reportId = await reports.createReport({
        guildId,
        reporterId: reporter.id,
        reportedUserId: target.id,
        reason,
        evidenceUrl,
      });
    } catch (e) {
      console.error('[report] createReport failed', e);
      return interaction.reply({ content: 'Fehler beim Speichern des Reports.', flags: MessageFlags.Ephemeral });
    }

    // 6) post embed in report_channel
    const reportChannel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!reportChannel) {
      return interaction.reply({
        content: 'Der konfigurierte Report-Channel existiert nicht mehr. Bitte Admin informieren.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const embed = buildOpenEmbed(reportId, reporter, target, reason, evidenceUrl, Date.now());
    const row = buildOpenButtons(reportId);
    try {
      const msg = await reportChannel.send({ embeds: [embed], components: [row] });
      await reports.attachMessageId(reportId, msg.id);
    } catch (e) {
      console.warn('[report] cannot post to report channel', e?.code || e);
      return interaction.reply({
        content: 'Der Bot kann nicht in den Report-Channel posten. Bitte Admin informieren.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 7) cooldown + ack
    reports.touchCooldown(reporter.id);
    return interaction.reply({
      content: `✅ Report #${reportId} eingereicht. Die Moderation wird sich kümmern.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
```

- [ ] **Step 4: Confirm the command loads cleanly**

Run: `node -e "const r = require('./src/commands/report'); console.log(typeof r.execute === 'function' ? 'execute-OK' : 'execute-FAIL'); console.log(typeof r.data.toJSON === 'function' ? 'data-OK' : 'data-FAIL'); console.log(r.requiredTier ?? 'no-tier-as-expected')"`

Expected: three `*-OK` / `no-tier-as-expected` lines.

- [ ] **Step 5: Confirm the loader picks it up**

Run: `node -e "const { loadCommands } = require('./src/loadCommands'); const m = loadCommands(); for (const [k] of m) console.log(k)"`

Expected: list includes `report` alongside ban/kick/timeout/warn/etc.

- [ ] **Step 6: Commit**

```bash
git add src/commands/report.js
git commit -m "feat(report): add /report slash command (Stage 2c)

User-facing slash command takes user (required), reason (required, max 500
chars), and optional evidence_url. Validates report_channel configured,
blocks self/bot/off-server targets, enforces 60s cooldown via the in-mem
map from src/reports.js, and rejects open duplicates. On success inserts
into reports, posts the open-state embed with [Übernehmen][Resolve]
[Verwerfen] buttons into the report_channel, attaches the resulting
message_id back to the row, touches the cooldown, and acks the reporter
ephemerally with the new report number.

No requiredTier — every guild member can submit a report (same loader
pattern as /setup)."
```

---

## Task 5a: `src/interactions/report.js` — Skeleton + Claim Handler

**Files:**
- Create: `src/interactions/report.js`

### Step-by-step

- [ ] **Step 1: Create `src/interactions/report.js` with dispatcher skeleton**

```js
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');
const reports = require('../reports');
const perms = require('../perms');
const config = require('../config');
const cases = require('../cases');
const { parseDuration, formatDuration, MAX_TIMEOUT_MS } = require('../duration');
const { getPool } = require('../db');

const COLOR_OPEN          = 0xFEE75C;
const COLOR_INVESTIGATING = 0x5865F2;
const COLOR_RESOLVED_CASE = 0x57F287;
const COLOR_RESOLVED_NONE = 0x95A5A6;
const COLOR_DISMISSED     = 0xED4245;

// ---------- Dispatcher ----------

async function dispatch(interaction) {
  if (!interaction.customId) return false;
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'report') return false;
  const kind = parts[1];
  const reportId = Number(parts[2]);
  if (!Number.isFinite(reportId)) return false;

  if (kind === 'claim'         && interaction.isButton())            { await handleClaim(interaction, reportId); return true; }
  if (kind === 'resolve'       && interaction.isButton())            { await handleResolveOpenSelect(interaction, reportId); return true; }
  if (kind === 'dismiss'       && interaction.isButton())            { await handleDismissOpenModal(interaction, reportId); return true; }
  if (kind === 'action-select' && interaction.isStringSelectMenu()) { await handleActionSelect(interaction, reportId); return true; }
  if (kind === 'modal-resolve' && interaction.isModalSubmit())       { await handleModalResolve(interaction, reportId, parts[3]); return true; }
  if (kind === 'modal-dismiss' && interaction.isModalSubmit())       { await handleModalDismiss(interaction, reportId); return true; }

  return false;
}

// ---------- Embed builders (used by all handlers) ----------

function buildEmbedBase(report, reporter, target) {
  const embed = new EmbedBuilder()
    .setTitle(`Report #${report.id}`)
    .addFields(
      { name: 'Gemeldeter User', value: `<@${report.reported_user_id}> (${report.reported_user_id})`, inline: true },
      { name: 'Reporter', value: `<@${report.reporter_id}> (${report.reporter_id})`, inline: true },
      { name: 'Grund', value: report.reason },
    );
  if (report.evidence_url) {
    embed.addFields({ name: 'Evidence', value: `[Link](${report.evidence_url})` });
  }
  embed.addFields({ name: 'Eingegangen', value: `<t:${Math.floor(new Date(report.created_at).getTime() / 1000)}:R>`, inline: true });
  return embed;
}

function buildClaimedState(report) {
  const embed = buildEmbedBase(report)
    .setColor(COLOR_INVESTIGATING)
    .setTitle(`🔵 Report #${report.id}`)
    .addFields({ name: 'Status', value: `🔵 In Bearbeitung von <@${report.assigned_mod_id}>`, inline: true });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`report:resolve:${report.id}`).setLabel('Resolve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`report:dismiss:${report.id}`).setLabel('Verwerfen').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

function buildResolvedState(report, action, caseNumber) {
  const isNone = action === 'none';
  const embed = buildEmbedBase(report)
    .setColor(isNone ? COLOR_RESOLVED_NONE : COLOR_RESOLVED_CASE)
    .setTitle(`✅ Report #${report.id}`);
  const statusValue = isNone
    ? `✅ Resolved von <@${report.assigned_mod_id}> → Keine Action`
    : `✅ Resolved von <@${report.assigned_mod_id}> → ${action} (Case #${caseNumber})`;
  embed.addFields({ name: 'Status', value: statusValue, inline: true });
  if (report.resolution_note) embed.setFooter({ text: report.resolution_note });
  return { embeds: [embed], components: [] };
}

function buildDismissedState(report) {
  const embed = buildEmbedBase(report)
    .setColor(COLOR_DISMISSED)
    .setTitle(`🚫 Report #${report.id}`)
    .addFields({ name: 'Status', value: `🚫 Verworfen von <@${report.assigned_mod_id}>`, inline: true });
  if (report.resolution_note) embed.setFooter({ text: report.resolution_note });
  return { embeds: [embed], components: [] };
}

async function editReportMessage(guild, channelId, report, newState) {
  if (!report.message_id) return false;
  try {
    const channel = await guild.channels.fetch(channelId);
    const msg = await channel.messages.fetch(report.message_id.toString());
    await msg.edit(newState);
    return true;
  } catch (e) {
    console.warn(`[reports] cannot edit report message ${report.message_id}`, e?.code || e);
    return false;
  }
}

// ---------- handleClaim ----------

async function handleClaim(interaction, reportId) {
  if (!(await perms.requireTier(interaction, 'moderator'))) return;

  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const report = await reports.getReport(reportId, { forUpdate: true, conn });
    if (!report) {
      await conn.rollback();
      return interaction.reply({ content: 'Report existiert nicht (mehr).', flags: MessageFlags.Ephemeral });
    }
    if (report.status === 'resolved' || report.status === 'dismissed') {
      await conn.rollback();
      return interaction.reply({ content: 'Report ist bereits abgeschlossen.', flags: MessageFlags.Ephemeral });
    }

    // Re-claim by same mod = idempotent ack
    if (report.status === 'investigating' && report.assigned_mod_id?.toString() === interaction.user.id) {
      await conn.rollback();
      return interaction.reply({ content: `Du hast Report #${reportId} bereits übernommen.`, flags: MessageFlags.Ephemeral });
    }

    await reports.claimReport(reportId, interaction.user.id, { conn });
    await conn.commit();

    const updated = { ...report, status: 'investigating', assigned_mod_id: interaction.user.id };
    const channelId = await config.getReportChannelId(interaction.guildId);
    await editReportMessage(interaction.guild, channelId, updated, buildClaimedState(updated));
    return interaction.reply({ content: `Du übernimmst Report #${reportId}.`, flags: MessageFlags.Ephemeral });
  } catch (e) {
    await conn.rollback();
    console.error('[reports] handleClaim error', e);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Fehler bei Übernehmen.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  } finally {
    conn.release();
  }
}

// ---------- TODO: handleResolveOpenSelect, handleActionSelect, handleModalResolve, handleDismissOpenModal, handleModalDismiss ----------

async function handleResolveOpenSelect(interaction, reportId) {
  return interaction.reply({ content: '(not yet implemented — Task 5b)', flags: MessageFlags.Ephemeral });
}
async function handleActionSelect(interaction, reportId) {
  return interaction.reply({ content: '(not yet implemented — Task 5b)', flags: MessageFlags.Ephemeral });
}
async function handleModalResolve(interaction, reportId, action) {
  return interaction.reply({ content: '(not yet implemented — Task 5c)', flags: MessageFlags.Ephemeral });
}
async function handleDismissOpenModal(interaction, reportId) {
  return interaction.reply({ content: '(not yet implemented — Task 5d)', flags: MessageFlags.Ephemeral });
}
async function handleModalDismiss(interaction, reportId) {
  return interaction.reply({ content: '(not yet implemented — Task 5d)', flags: MessageFlags.Ephemeral });
}

module.exports = { dispatch };
```

The placeholder stubs let us wire up `index.js` in Task 6 and visually confirm the dispatcher routing before implementing each handler. They will all be replaced in 5b/5c/5d — *NOT shipped as TODO comments in the final state*.

- [ ] **Step 2: Confirm module loads**

Run: `node -e "const i = require('./src/interactions/report'); console.log(typeof i.dispatch === 'function' ? 'OK' : 'FAIL')"`

Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add src/interactions/report.js
git commit -m "feat(interactions): scaffold src/interactions/report.js + handleClaim

Introduces the project's first non-slash interaction handler module. The
dispatch(interaction) entry point splits the customId on ':' and routes to
the per-kind handler. handleClaim is fully implemented: requireTier
moderator, SELECT FOR UPDATE in a transaction so two simultaneous claims
can't race, idempotent re-claim by same mod, embed edit to the blurple
'investigating' state with only Resolve/Verwerfen buttons remaining.

Five remaining handlers stubbed with placeholder replies — those land in
Task 5b/5c/5d. The stubs are NOT marked TODO in the final shipping state;
each will be fully implemented before its task commits."
```

---

## Task 5b: Resolve-Button + Action-Select Handlers

**Files:**
- Modify: `src/interactions/report.js` (replace `handleResolveOpenSelect` + `handleActionSelect` stubs)

### Step-by-step

- [ ] **Step 1: Implement `handleResolveOpenSelect`**

Replace the stub:

```js
async function handleResolveOpenSelect(interaction, reportId) {
  if (!(await perms.requireTier(interaction, 'moderator'))) return;

  const report = await reports.getReport(reportId);
  if (!report) {
    return interaction.reply({ content: 'Report existiert nicht (mehr).', flags: MessageFlags.Ephemeral });
  }
  if (report.status === 'resolved' || report.status === 'dismissed') {
    return interaction.reply({ content: 'Report ist bereits abgeschlossen.', flags: MessageFlags.Ephemeral });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`report:action-select:${reportId}`)
    .setPlaceholder('Aktion wählen')
    .addOptions(
      { label: 'None',    value: 'none',    description: 'Report ohne Action abschließen', emoji: '✅' },
      { label: 'Warn',    value: 'warn',    description: 'Verwarnung aussprechen',         emoji: '⚠️' },
      { label: 'Timeout', value: 'timeout', description: 'User timeout-en',                emoji: '⏱️' },
      { label: 'Kick',    value: 'kick',    description: 'User kicken (owner-Tier)',       emoji: '👢' },
      { label: 'Ban',     value: 'ban',     description: 'User bannen (owner-Tier)',       emoji: '🔨' },
    );

  return interaction.reply({
    content: 'Aktion wählen:',
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}
```

- [ ] **Step 2: Implement `handleActionSelect`**

Replace the stub:

```js
async function handleActionSelect(interaction, reportId) {
  const action = interaction.values[0]; // 'none' | 'warn' | 'timeout' | 'kick' | 'ban'

  // Per-action tier:
  const requiredActionTier = (action === 'kick' || action === 'ban') ? 'owner' : 'moderator';
  if (!(await perms.hasTier(interaction.member, requiredActionTier))) {
    return interaction.update({
      content: `Aktion **${action}** benötigt **${requiredActionTier}**-Tier.`,
      components: [],
    });
  }

  // Build action-specific modal
  const modal = new ModalBuilder()
    .setCustomId(`report:modal-resolve:${reportId}:${action}`)
    .setTitle(action === 'none' ? `Report #${reportId} abschließen` : `Resolve: ${action}`);

  if (action === 'none') {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('resolution_note')
          .setLabel('Notiz (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500),
      ),
    );
  } else if (action === 'timeout') {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('duration')
          .setLabel('Dauer (z.B. 30s, 10m, 2h, 1t, 1w)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(16)
          .setValue('60m'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Grund')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500),
      ),
    );
  } else {
    // warn / kick / ban → just reason
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Grund')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500),
      ),
    );
  }

  await interaction.showModal(modal);
}
```

- [ ] **Step 3: Confirm module still loads**

Run: `node -e "require('./src/interactions/report')" && echo "OK"`

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add src/interactions/report.js
git commit -m "feat(interactions): implement Resolve→Select→Modal flow

handleResolveOpenSelect (Resolve-button) replies ephemerally with a
StringSelectMenu offering None/Warn/Timeout/Kick/Ban. handleActionSelect
checks the per-action tier (warn/timeout/none → moderator OK; kick/ban →
owner) and rejects on mismatch via interaction.update so the ephemeral
message is replaced in place. On tier pass it shows the action-specific
Modal: None gets only an optional Note, Timeout gets a prefilled '60m'
Duration + required Reason, the other three actions get only a required
Reason. All TextInputs cap at 500 chars / 16 for the duration."
```

---

## Task 5c: Resolve-Modal Submit Handler

This is the most complex handler — discord-action execution + case creation + mod-log embed posting all in one transaction.

**Files:**
- Modify: `src/interactions/report.js` (replace `handleModalResolve` stub + add internal helpers)

### Step-by-step

- [ ] **Step 1: Read the mod-log embed pattern from `src/commands/warn.js`**

Run: `Grep -n -A 25 "modLog\|mod_log\|getModLogChannelId" src/commands/warn.js`

Identify exactly what fields the warn mod-log embed has (typically: User, Moderator, Reason, Case#, color, timestamp). The Resolve flow must produce a structurally identical embed so all Mod-Log entries look the same regardless of whether they came from `/warn` or `/report → warn`.

Do the same brief read for `src/commands/timeout.js` (extra Dauer/Läuft ab fields), `src/commands/kick.js`, `src/commands/ban.js` — note any per-action-type differences in the embed.

- [ ] **Step 2: Add helper for the mod-log embed inside `src/interactions/report.js`**

Below the existing builders (`buildClaimedState`, `buildResolvedState`, `buildDismissedState`), add:

```js
function buildModLogEmbed({ action, caseNumber, target, mod, reason, durationMs, expiresAtSec }) {
  const colors = {
    warn: 0xFEE75C,    // yellow
    timeout: 0xFAA61A, // orange
    kick: 0xE67E22,    // dark orange
    ban: 0xED4245,     // red
  };
  const titles = {
    warn: '⚠️ Warn',
    timeout: '⏱️ Timeout',
    kick: '👢 Kick',
    ban: '🔨 Ban',
  };
  const embed = new EmbedBuilder()
    .setColor(colors[action])
    .setTitle(`${titles[action]} · Case #${caseNumber}`)
    .addFields(
      { name: 'User', value: `<@${target.id}> (${target.username})`, inline: true },
      { name: 'Moderator', value: `<@${mod.id}> (${mod.username})`, inline: true },
      { name: 'Grund', value: reason },
    )
    .setTimestamp(new Date());
  if (action === 'timeout' && durationMs != null) {
    embed.addFields(
      { name: 'Dauer', value: formatDuration(durationMs), inline: true },
      { name: 'Läuft ab', value: `<t:${expiresAtSec}:f>`, inline: true },
    );
  }
  return embed;
}
```

**Note:** The exact field set should match what the existing mod-commands produce. After Step 1's read of `warn.js`/`timeout.js`/etc., adjust the helper above if any field name or layout differs — the goal is byte-identical mod-log entries no matter the path.

- [ ] **Step 3: Implement `handleModalResolve`**

Replace the stub:

```js
async function handleModalResolve(interaction, reportId, action) {
  // Defer ephemeral so we don't 3s timeout while doing discord-actions + db
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const reason = interaction.fields.getTextInputValue('reason') ?? null;
  const note = action === 'none'
    ? (interaction.fields.getTextInputValue('resolution_note') ?? null)
    : reason; // for non-none, the reason doubles as the resolution_note
  const durationInput = action === 'timeout' ? interaction.fields.getTextInputValue('duration') : null;

  let durationMs = null;
  let expiresAtSec = null;
  if (action === 'timeout') {
    durationMs = parseDuration(durationInput);
    if (!durationMs) {
      return interaction.editReply({ content: 'Ungültige Dauer. Nutze z.B. `30s`, `10m`, `2h`, `1t`, `1w`.' });
    }
    if (durationMs > MAX_TIMEOUT_MS) {
      return interaction.editReply({ content: 'Maximale Timeout-Dauer ist 28 Tage.' });
    }
    expiresAtSec = Math.floor((Date.now() + durationMs) / 1000);
  }

  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Race-check
    const report = await reports.getReport(reportId, { forUpdate: true, conn });
    if (!report) {
      await conn.rollback();
      return interaction.editReply({ content: 'Report existiert nicht (mehr).' });
    }
    if (report.status === 'resolved' || report.status === 'dismissed') {
      await conn.rollback();
      return interaction.editReply({ content: 'Report wurde inzwischen von einem anderen Mod bearbeitet.' });
    }

    let caseNumber = null;

    if (action !== 'none') {
      // Fetch target — for kick/timeout we need the live member; for ban/warn we can fall back to the user ID
      const targetMember = await interaction.guild.members.fetch(report.reported_user_id.toString()).catch(() => null);
      const targetUser = targetMember?.user ?? await interaction.client.users.fetch(report.reported_user_id.toString()).catch(() => null);

      if ((action === 'kick' || action === 'timeout') && !targetMember) {
        await conn.rollback();
        return interaction.editReply({ content: 'User ist nicht mehr auf dem Server — Aktion nicht möglich.' });
      }
      if (!targetUser) {
        await conn.rollback();
        return interaction.editReply({ content: 'User konnte nicht aufgelöst werden.' });
      }

      // Execute Discord-action
      try {
        const auditReason = `${interaction.user.tag}: ${reason}`;
        if (action === 'timeout') await targetMember.timeout(durationMs, auditReason);
        else if (action === 'kick') await targetMember.kick(auditReason);
        else if (action === 'ban') await interaction.guild.bans.create(report.reported_user_id.toString(), { reason: auditReason });
        // warn → no discord call
      } catch (e) {
        await conn.rollback();
        console.error('[reports] discord action failed', e);
        return interaction.editReply({ content: `Konnte ${action} nicht ausführen: ${e?.message ?? 'Discord-Fehler'}.` });
      }

      // Create case (cases.createCase runs its own transaction — do NOT pass conn)
      try {
        caseNumber = await cases.createCase({
          guildId: interaction.guildId,
          userId: report.reported_user_id.toString(),
          moderatorId: interaction.user.id,
          type: action,
          reason,
          durationMs: action === 'timeout' ? BigInt(durationMs) : null,
          expiresAt: action === 'timeout' ? new Date(Date.now() + durationMs) : null,
        });
      } catch (e) {
        await conn.rollback();
        console.error('[reports] createCase failed', e);
        return interaction.editReply({ content: 'Konnte Case nicht erstellen — Aktion war erfolgreich, bitte manuell mit /reason nachtragen.' });
      }

      // Post mod-log embed (fail-soft)
      const modLogChannelId = await config.getModLogChannelId(interaction.guildId);
      if (modLogChannelId) {
        const modLogChannel = await interaction.guild.channels.fetch(modLogChannelId).catch(() => null);
        if (modLogChannel) {
          await modLogChannel.send({
            embeds: [buildModLogEmbed({
              action, caseNumber,
              target: targetUser,
              mod: interaction.user,
              reason,
              durationMs,
              expiresAtSec,
            })],
          }).catch(e => console.warn('[reports] modlog send failed', e?.code || e));
        }
      }
    }

    // Update report row
    await reports.resolveReport(reportId, {
      modId: interaction.user.id,
      note,
      caseNumber,
      conn,
    });

    await conn.commit();

    // Edit the report embed in-place
    const updatedReport = { ...report, status: 'resolved', assigned_mod_id: interaction.user.id, resolution_note: note };
    const channelId = await config.getReportChannelId(interaction.guildId);
    await editReportMessage(interaction.guild, channelId, updatedReport, buildResolvedState(updatedReport, action, caseNumber));

    return interaction.editReply({
      content: action === 'none'
        ? `Report #${reportId} ohne Action abgeschlossen.`
        : `Report #${reportId} als **${action}** resolved (Case #${caseNumber}).`,
    });
  } catch (e) {
    await conn.rollback();
    console.error('[reports] handleModalResolve error', e);
    if (!interaction.replied) {
      await interaction.editReply({ content: 'Unerwarteter Fehler bei Resolve.' }).catch(() => {});
    }
  } finally {
    conn.release();
  }
}
```

- [ ] **Step 4: Confirm module loads**

Run: `node -e "require('./src/interactions/report')" && echo "OK"`

Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add src/interactions/report.js
git commit -m "feat(interactions): implement Resolve-modal submit handler

handleModalResolve is the heaviest path: it parses+validates the action-
specific modal fields, deferReply ephemerally (3s timeout protection
during discord+db work), races-checks via SELECT FOR UPDATE so two
concurrent Resolves don't both fire actions, executes the Discord-action
(timeout/kick/ban — warn has no API call), creates the Infraction-Case
via cases.createCase, posts a structurally identical mod-log embed to the
configured mod-log channel (fail-soft on missing channel or send error),
updates the reports row with status/resolution_note/resolution_case_number,
commits, then edits the report embed to the green/grey 'resolved' state.

Rollback path is comprehensive: invalid duration, missing target member
for kick/timeout, discord-action failure, and cases.createCase failure
all roll back the transaction and reply with a useful ephemeral. The
mod-log post is intentionally outside the transaction so a flaky channel
send can't undo a completed mod-action."
```

---

## Task 5d: Verwerfen Button + Modal Handlers

**Files:**
- Modify: `src/interactions/report.js` (replace `handleDismissOpenModal` + `handleModalDismiss` stubs)

### Step-by-step

- [ ] **Step 1: Implement `handleDismissOpenModal`**

Replace the stub:

```js
async function handleDismissOpenModal(interaction, reportId) {
  if (!(await perms.requireTier(interaction, 'moderator'))) return;

  const report = await reports.getReport(reportId);
  if (!report) {
    return interaction.reply({ content: 'Report existiert nicht (mehr).', flags: MessageFlags.Ephemeral });
  }
  if (report.status === 'resolved' || report.status === 'dismissed') {
    return interaction.reply({ content: 'Report ist bereits abgeschlossen.', flags: MessageFlags.Ephemeral });
  }

  const modal = new ModalBuilder()
    .setCustomId(`report:modal-dismiss:${reportId}`)
    .setTitle(`Report #${reportId} verwerfen`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('resolution_note')
          .setLabel('Grund (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500)
          .setPlaceholder('z.B. Doppel-Report, kein Verstoß, …'),
      ),
    );
  await interaction.showModal(modal);
}
```

- [ ] **Step 2: Implement `handleModalDismiss`**

Replace the stub:

```js
async function handleModalDismiss(interaction, reportId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const note = interaction.fields.getTextInputValue('resolution_note') || null;

  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const report = await reports.getReport(reportId, { forUpdate: true, conn });
    if (!report) {
      await conn.rollback();
      return interaction.editReply({ content: 'Report existiert nicht (mehr).' });
    }
    if (report.status === 'resolved' || report.status === 'dismissed') {
      await conn.rollback();
      return interaction.editReply({ content: 'Report wurde inzwischen abgeschlossen.' });
    }

    await reports.dismissReport(reportId, { modId: interaction.user.id, note, conn });
    await conn.commit();

    const updatedReport = { ...report, status: 'dismissed', assigned_mod_id: interaction.user.id, resolution_note: note };
    const channelId = await config.getReportChannelId(interaction.guildId);
    await editReportMessage(interaction.guild, channelId, updatedReport, buildDismissedState(updatedReport));

    return interaction.editReply({ content: `Report #${reportId} verworfen.` });
  } catch (e) {
    await conn.rollback();
    console.error('[reports] handleModalDismiss error', e);
    await interaction.editReply({ content: 'Fehler bei Verwerfen.' }).catch(() => {});
  } finally {
    conn.release();
  }
}
```

- [ ] **Step 3: Confirm module loads**

Run: `node -e "require('./src/interactions/report')" && echo "OK"`

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add src/interactions/report.js
git commit -m "feat(interactions): implement Verwerfen modal flow

handleDismissOpenModal (Verwerfen-button) opens a Modal with one optional
Paragraph TextInput for the resolution note, after the same status guard
the Resolve flow uses. handleModalDismiss runs the dismiss in a transaction
with SELECT FOR UPDATE race-check, updates the row, then edits the report
embed to the red 'dismissed' state with the note in the footer (if set).
Empty note keeps resolution_note NULL.

All five handlers in src/interactions/report.js are now fully implemented
— no placeholder stubs remain."
```

---

## Task 6: Wire dispatcher into `index.js`

**Files:**
- Modify: `index.js` (extend the existing `InteractionCreate` handler)

### Step-by-step

- [ ] **Step 1: Read the current `index.js` InteractionCreate handler**

Run: `Grep -n -A 30 "InteractionCreate" index.js`

Note the existing slash-command path so the diff stays minimal.

- [ ] **Step 2: Add the require + dispatcher**

Near the top of `index.js`, after the existing `const { ... } = require('discord.js');` etc., add:

```js
const reportInteractions = require('./src/interactions/report');
```

Then, inside the `client.on(Events.InteractionCreate, async (interaction) => { ... })` callback, after the existing slash-command handling block, add the new component path. The final shape should look like:

```js
client.on(Events.InteractionCreate, async (interaction) => {
  // Existing slash-command path — unchanged
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    // ... existing execute call with try/catch, requiredTier middleware, etc. unchanged ...
    return;
  }

  // New: button / select-menu / modal path
  if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
    try {
      const handled = await reportInteractions.dispatch(interaction);
      if (!handled) {
        await interaction.reply({ content: 'Unbekannte Interaktion.', flags: MessageFlags.Ephemeral });
      }
    } catch (e) {
      console.error('[interactions] dispatch error', e);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Fehler bei der Verarbeitung.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  }
});
```

Do **not** touch the slash-command path itself. The existing `if (!interaction.isChatInputCommand()) return;` (or equivalent early-return) at the top of the original handler must be converted to an `if (interaction.isChatInputCommand()) { ... return; }` so the component path can run.

- [ ] **Step 3: Smoke-load index.js (no boot)**

Run: `node -e "require.cache && delete require.cache[require.resolve('./index.js')]; try { require('./index.js') } catch (e) { console.log('expected env error or login error:', e?.code || e?.name || 'unknown'); }"`

Expected: either Discord login fails (because no TOKEN in current env) or DB ping fails — but **not** a syntax error or missing-module error. The require itself must succeed.

If the file actually boots in the dev environment, that's also fine; Ctrl-C the process.

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat(index): route button/select/modal interactions to report dispatcher

Splits the existing InteractionCreate handler in two: the slash-command
path stays exactly as-is, and a new component path catches isButton +
isStringSelectMenu + isModalSubmit and forwards to
reportInteractions.dispatch. The dispatcher returns true if it handled
the customId (those starting with 'report:'), false otherwise — false
yields a generic 'Unbekannte Interaktion' ephemeral so users never see
silent failures while we still have room to add more dispatchers
(escalation/automod) in the same try/catch as future stages roll in."
```

---

## Task 7: Manual E2E Verification

**No files modified.** Pure checklist run in a live Discord guild against the bot.

**Pre-flight (do once):**
- [ ] Bot is running locally (`node index.js`) and connected to the test guild
- [ ] `/setup` has been run in the test guild
- [ ] `/config channel set type:report channel:#reports` has been run
- [ ] `/config channel set type:mod_log channel:#mod-log` has been run
- [ ] You have an account with **owner-tier** and a second account with **moderator-tier**, plus a regular-member account, plus an account to be the target ("@victim")

**Scenarios:**

- [ ] **1. Happy path:** Regular member: `/report user:@victim reason:Spam in #general`
  - Ephemeral: "✅ Report #N eingereicht"
  - #reports: yellow embed with Übernehmen / Resolve / Verwerfen buttons

- [ ] **2. Self-report blocked:** Member runs `/report user:<themselves>` → ephemeral "Du kannst dich nicht selbst melden", no embed in #reports

- [ ] **3. Bot-report blocked:** Member runs `/report user:@Oreo` → ephemeral "Bots können nicht gemeldet werden"

- [ ] **4. Off-server target blocked:** Use a user-ID for someone who left → ephemeral "User ist nicht (mehr) auf dem Server"

- [ ] **5. Duplicate blocked:** Same reporter runs `/report user:@victim reason:other` while the previous report is still open → ephemeral "Du hast bereits einen offenen Report gegen diesen User"

- [ ] **6. Cooldown blocks:** Reporter waits >60s, files report against a *different* user → succeeds. Immediately tries another → ephemeral cooldown message with remaining seconds

- [ ] **7. Übernehmen by mod:** Moderator-account clicks Übernehmen on an open report → embed turns blurple, status changes to "🔵 In Bearbeitung von @mod", Übernehmen button disappears, Resolve + Verwerfen remain

- [ ] **8. Re-claim by other mod:** Owner-account clicks Übernehmen on the same already-investigating report → embed re-assigns to @owner, no error

- [ ] **9. Resolve → None (moderator):** Moderator clicks Resolve → ephemeral select menu appears → select "None" → modal with optional Note → submit empty → embed turns grey, status "Resolved → Keine Action", all buttons gone, **no entry in #mod-log**

- [ ] **10. Resolve → Warn (moderator):** Same flow, select Warn → modal asks for Reason → submit → embed turns green, status "Resolved → warn (Case #N)", #mod-log gets a yellow Warn entry, `/case <N>` shows the case as expected, target user gets no DM, **target embed in #mod-log shows moderator = the resolver, not the reporter**

- [ ] **11. Resolve → Timeout (moderator):** Select Timeout → modal prefilled with 60m → submit → discord.js applies the timeout to the target, embed status shows duration, #mod-log entry has Dauer + Läuft ab fields

- [ ] **12. Resolve → Timeout with invalid duration:** Select Timeout → submit "garbage" → ephemeral "Ungültige Dauer" → no DB change, no Discord action

- [ ] **13. Resolve → Timeout exceeding 28d:** Select Timeout → submit "30t" → ephemeral "Maximale Timeout-Dauer ist 28 Tage"

- [ ] **14. Resolve → Kick by moderator:** Select Kick → ephemeral "Aktion **kick** benötigt **owner**-Tier", modal does not open, no DB change

- [ ] **15. Resolve → Kick by owner:** Owner repeats: target is kicked, Case created, embed turns green, #mod-log entry, target leaves the server

- [ ] **16. Resolve → Ban by owner:** Same as 15 with Ban — target is banned

- [ ] **17. Verwerfen with note:** Click Verwerfen → modal opens → enter "Doppel-Report" → submit → embed turns red, status "Verworfen", footer shows the note

- [ ] **18. Verwerfen empty:** Click Verwerfen → modal opens → submit empty → embed turns red, no footer note (resolution_note NULL)

- [ ] **19. Race-condition:** Two mod accounts on two devices: both click Resolve on the same open report → first one's modal submits successfully, second one's modal-submit ephemeral says "Report wurde inzwischen von einem anderen Mod bearbeitet."

- [ ] **20. Embed-message deleted:** Manually delete the report embed from #reports → click any leftover interaction (if you saved a URL) — DB state still updates; user sees a useful ephemeral

- [ ] **21. Report-channel not configured:** Run `/config channel unset type:report` → next `/report` from any member → ephemeral hint mentioning the exact `/config channel set type:report` command

- [ ] **22. Bot has no Send permission in report-channel:** Revoke "Send Messages" from the bot in #reports → `/report` → ephemeral fail-soft "Bot kann nicht in den Report-Channel posten"

- [ ] **23. Anonymity at /case:** Run `/case <N>` for any case created via Resolve flow → output shows moderator = resolver, never the reporter. Confirms anonymity end-to-end.

**Acceptance:** every box ticked. If any fails, file a follow-up before pushing.

- [ ] **Commit checklist completion (optional)**

After running the checklist in a separate doc/comments, no code commit. Move to Task 8 (push) or hold for Q&A.

---

## Task 8: Push to origin

- [ ] **Step 1: Confirm clean working tree**

Run: `git status`

Expected: nothing staged, nothing modified — everything committed across Tasks 1–6.

- [ ] **Step 2: Push**

Run: `git push origin main`

Expected: 6–7 new commits land on origin.

---

## Out-of-Scope Reminders (do NOT do these in this plan)

- No `/case <N>` reverse-lookup that shows the linked report
- No `/report list` / `/report show <id>` commands
- No Mod-Log builder refactor (duplication is accepted in Stage 2c)
- No re-open / un-claim / re-post for deleted embed messages
- No automatic Reporter-DMs (privacy-by-default per design)
- No escalation rules / automod integration

These are deferred to Stage 2d / 3 / 4 per the design spec §11.

---

## Self-Review Trace

**Spec coverage** (cross-reference against `docs/superpowers/specs/2026-06-01-report-system-stage2c-design.md`):

| Spec section | Covered by |
|---|---|
| §3 Architecture | File-Plan + Tasks 3, 4, 5a–d, 6 |
| §3.1 customId scheme | Task 4 (button customIds), 5a–d (handlers), 5a dispatcher |
| §3.2 Dispatcher in index.js | Task 6 |
| §4.2 DB Migration | Task 1 |
| §4.3 Status machine | Tasks 5a (claim), 5c (resolve), 5d (dismiss) |
| §5 /report Slash | Task 4 |
| §5.3 Cooldown | Task 3 (impl) + Task 4 (use) |
| §5.4 Duplicate-check | Task 3 (impl) + Task 4 (use) |
| §6 Embed + colors | Task 4 (open), Task 5a (claimed/resolved/dismissed builders) |
| §6.4 editReportMessage | Task 5a (shared helper) |
| §6.5 Anonymität | Confirmed at E2E #10 + #23 |
| §7.1 handleClaim | Task 5a |
| §7.2 handleResolveOpenSelect | Task 5b |
| §7.3 handleActionSelect | Task 5b |
| §7.4 handleModalResolve | Task 5c |
| §7.5 handleDismissOpenModal / handleModalDismiss | Task 5d |
| §7.6 Mod-Log embed posting | Task 5c |
| §8 reports.js API | Task 3 |
| §9 Error-handling matrix | Tasks 4 (validation paths), 5a (claim race), 5c (resolve race + discord/case failures), 5d (dismiss race), 6 (dispatcher try/catch) |
| §10.1 Smoke test | Tasks 2 (duration), 3 (reports) |
| §10.2 Manual E2E | Task 7 |
| §12 Rollback | Additive schema only — Task 1 |

**Placeholder scan:** no "TBD", "TODO", "implement later", or stub-only steps remain in any task. The Task 5a placeholder handlers are explicitly marked as scaffolding that gets replaced by Tasks 5b/5c/5d before commit, and the plan documents that "stubs are NOT shipped in the final state."

**Type/identifier consistency:**
- `reports.createReport({ guildId, reporterId, reportedUserId, reason, evidenceUrl })` — Tasks 3, 4 match
- `reports.attachMessageId(reportId, messageId)` — Tasks 3, 4 match
- `reports.getReport(reportId, { forUpdate, conn })` — Tasks 3, 5a, 5c, 5d match
- `reports.claimReport(reportId, modId, { conn })` — Tasks 3, 5a match
- `reports.resolveReport(reportId, { modId, note, caseNumber, conn })` — Tasks 3, 5c match
- `reports.dismissReport(reportId, { modId, note, conn })` — Tasks 3, 5d match
- `reports.checkCooldown(userId)` / `touchCooldown(userId)` — Tasks 3, 4 match
- `cases.createCase({ guildId, userId, moderatorId, type, reason, durationMs, expiresAt })` — Task 5c matches the existing signature documented in memory 7502
- `parseDuration(input)` / `formatDuration(ms)` / `MAX_TIMEOUT_MS` — Tasks 2, 5c match
- customId prefix `report:<kind>:<reportId>[:<action>]` — Task 4 (emit), Task 5a (parse), Tasks 5b–d (re-emit + parse) match
- Embed-color constants — defined once in Task 5a, referenced consistently from all state builders
