# Oreo Audit-Bugfixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all critical and high-severity bugs from the 2026-07-06 audit: captcha bypass, speech privacy leak, duration parsing, autocomplete permission leak, crash-proofing, temp-ban data loss, anti-raid self-DoS, channel-hopping false positives, timezone-safe expiry, and tier realignment.

**Architecture:** Targeted fixes inside the existing structure — no new dependencies, no framework changes. Two new small modules (`src/verifications.js` DAL, `src/interactions/voiceconfirm.js` dispatcher), one new DB table (`pending_verifications`). Everything else edits existing files.

**Tech Stack:** discord.js v14, CommonJS, Node >= 20, mysql2/promise, plain-assert smoke tests (`tests/smoke/*.js` run as child processes by `tests/run.js`).

## Global Constraints

- All user-facing strings in **German**; code/comments/logs in English (match existing file style).
- CommonJS (`require`/`module.exports`) only — no ESM, no TypeScript.
- No new npm dependencies.
- `npm test` needs a reachable MySQL (reads `.env` itself); it runs `ensureSchema()` first, so new tables in `server/schema.sql` are auto-created.
- Every slash command is **auto-deferred ephemerally** by index.js before `execute()` and `interaction.reply` is monkey-patched to `editReply` — command replies stay ephemeral; do not add `showModal()` calls in any command touched here.
- Duration units after Task 1: `s / m / h / t / d / w` (`t` and `d` are both "Tag"); temp-ban/mute cap = 365 days.
- Tier ladder is `supporter < moderator < owner` (no `admin` tier exists).
- Commit after every task with a `fix:`/`feat:` conventional message.
- Working dir: `c:\Users\Lukas\Documents\Home Discord Bots\Oreo` (repo root; branch off `main`).

**Setup before Task 1:** `git checkout -b fix/audit-2026-07`

---

### Task 1: Duration parser — accept `d`, add temp-action cap

**Files:**
- Modify: `src/duration.js`
- Modify: `src/commands/ban.js` (duration validation block, ~line 37)
- Modify: `src/commands/mute.js` (duration validation block, ~line 84)
- Test: `tests/smoke/duration.js`

**Interfaces:**
- Produces: `parseDuration(str)` now maps `d` → 86 400 000 ms/unit; new export `MAX_TEMP_MS` (365 days in ms). Consumed by Task 7 (ban/mute callers unchanged signatures).

- [ ] **Step 1: Extend the smoke test with failing assertions**

Append to `tests/smoke/duration.js` (before the final `console.log`):

```js
const { MAX_TEMP_MS } = require('../../src/duration');
assert.equal(parseDuration('7d'), 7 * 86_400_000, '7d → 7 days (d alias for Tag)');
assert.equal(parseDuration('1D'), 86_400_000, '1D → case-insensitive');
assert.equal(MAX_TEMP_MS, 365 * 86_400_000, 'MAX_TEMP_MS = 365 days');
assert.ok(parseDuration('999999999w') > MAX_TEMP_MS, 'huge duration parses but exceeds cap');
```

Note: `const { parseDuration, formatDuration, MAX_TIMEOUT_MS }` is already imported at the top — the new `MAX_TEMP_MS` require line above is separate on purpose so the file stays valid before the implementation exists (it will be `undefined`, and the assert fails).

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/smoke/duration.js`
Expected: AssertionError on `'7d → 7 days (d alias for Tag)'` (parseDuration('7d') returns null).

- [ ] **Step 3: Implement in src/duration.js**

Replace the two lines in `parseDuration`:

```js
  const match = str.trim().match(/^(\d+)\s*(s|m|h|t|d|w)$/i);
```

and

```js
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, t: 86_400_000, d: 86_400_000, w: 604_800_000 };
```

Add below `MAX_TIMEOUT_MS` at the top:

```js
const MAX_TEMP_MS = 365 * 24 * 60 * 60 * 1000; // Obergrenze für Temp-Ban/Temp-Mute
```

Change the export line to:

```js
module.exports = { parseDuration, formatDuration, MAX_TIMEOUT_MS, MAX_TEMP_MS };
```

- [ ] **Step 4: Enforce the cap in ban.js**

In `src/commands/ban.js`, change the import:

```js
const { parseDuration, MAX_TEMP_MS } = require('../duration');
```

Inside `if (durationInput) { ... }`, after the `if (!durationMs)` block, insert:

```js
      if (durationMs > MAX_TEMP_MS) {
        return interaction.reply({
          content: '❌ Die maximale Temp-Ban-Dauer beträgt 365 Tage. Für länger nutze einen permanenten Ban.',
          flags: MessageFlags.Ephemeral,
        });
      }
```

- [ ] **Step 5: Enforce the cap in mute.js**

Same pattern in `src/commands/mute.js`: import `MAX_TEMP_MS` alongside `parseDuration`, and after its `if (!durationMs)` block insert:

```js
      if (durationMs > MAX_TEMP_MS) {
        return interaction.reply({
          content: '❌ Die maximale Temp-Mute-Dauer beträgt 365 Tage.',
          flags: MessageFlags.Ephemeral,
        });
      }
```

- [ ] **Step 6: Run tests**

Run: `node tests/smoke/duration.js` → expected `OK — duration smoke test passed`.
Run: `npm test` → all 14 suites pass.

- [ ] **Step 7: Commit**

```bash
git add src/duration.js src/commands/ban.js src/commands/mute.js tests/smoke/duration.js
git commit -m "fix: accept 'd' duration suffix and cap temp ban/mute at 365 days"
```

---

### Task 2: Reason length limit (512) on all reason options

**Files:**
- Modify: every file in `src/commands/` that defines a `reason` string option (ban, unban, kick, softban, warn, removewarn, reason, timeout, untimeout, mute, unmute — verify list via grep in Step 1)

**Interfaces:**
- Produces: Discord client-side enforcement that `reason` never exceeds the `infractions.reason VARCHAR(512)` column, so `createCase` can no longer fail on overflow.

- [ ] **Step 1: Enumerate the option definitions**

Run: `grep -rn "setName('reason')" src/commands/`
Expected: a list of ~11 files. Each hit looks like (example from ban.js):

```js
.addStringOption((reason) => reason.setName('reason').setDescription('Grund für den Ban').setRequired(false))
```

- [ ] **Step 2: Add `.setMaxLength(512)` to every hit**

Transform each builder chain by appending `.setMaxLength(512)` after `.setDescription(...)`. Example (ban.js):

```js
.addStringOption((reason) => reason.setName('reason').setDescription('Grund für den Ban').setMaxLength(512).setRequired(false))
```

Apply the identical transformation in every file found in Step 1. Do not change anything else in the chains.

- [ ] **Step 3: Verify completeness**

Run: `grep -rln "setName('reason')" src/commands/ | xargs grep -Ln "setMaxLength(512)"`
Expected: no output (every file with a reason option now has the max length).

- [ ] **Step 4: Verify commands still deploy**

Run: `npm test` (loads command modules in several suites; a broken builder chain throws at require time). Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/
git commit -m "fix: enforce 512-char reason limit matching infractions.reason column"
```

---

### Task 3: No punishment without case row (temp-ban/mute data-loss fix)

**Files:**
- Modify: `src/commands/ban.js` (createCase catch block, ~line 100)
- Modify: `src/commands/mute.js` (createCase catch block, ~line 120)

**Interfaces:**
- Consumes: existing `cases.createCase(...)` and Discord `guild.members.unban` / `member.roles.remove`.
- Produces: invariant — a *temporary* ban/mute only stands if its `infractions` row exists; otherwise the action is reverted and the moderator informed.

- [ ] **Step 1: Revert temp ban when createCase fails (ban.js)**

Replace the existing catch block

```js
    } catch (err) {
      console.error('createCase failed:', err);
      caseNumber = null;
    }
```

with:

```js
    } catch (err) {
      console.error('createCase failed:', err);
      caseNumber = null;
      if (expiresAt) {
        // Ohne Case-Row kann der Background-Loop nie entbannen → Temp-Ban zurücknehmen.
        await interaction.guild.members.unban(target.id, 'Oreo: Temp-Ban zurückgenommen (Datenbankfehler)').catch(() => null);
        return interaction.reply({
          content: '❌ Datenbankfehler — der Temp-Ban wurde **zurückgenommen**, damit er nicht versehentlich permanent wird. Versuch es später erneut.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
```

(Note: `expiresAt` is the variable already set in the duration block; permanent bans keep the old best-effort behavior.)

- [ ] **Step 2: Revert temp mute when createCase fails (mute.js)**

Replace the identical catch block in mute.js with:

```js
    } catch (err) {
      console.error('createCase failed:', err);
      caseNumber = null;
      if (expiresAt) {
        await targetMember.roles.remove(role, 'Oreo: Temp-Mute zurückgenommen (Datenbankfehler)').catch(() => null);
        return interaction.reply({
          content: '❌ Datenbankfehler — der Temp-Mute wurde **zurückgenommen**, damit er nicht versehentlich permanent wird. Versuch es später erneut.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
```

- [ ] **Step 3: Run tests** — `npm test`, expected all pass.

- [ ] **Step 4: Commit**

```bash
git add src/commands/ban.js src/commands/mute.js
git commit -m "fix: revert temp ban/mute when case row cannot be written"
```

---

### Task 4: Align permission tiers with bot.md spec

**Files:**
- Modify: `src/commands/warn.js`, `src/commands/timeout.js`, `src/commands/untimeout.js` (→ `supporter`)
- Modify: `src/commands/ban.js`, `src/commands/unban.js`, `src/commands/kick.js`, `src/commands/softban.js` (→ `moderator`)
- Modify: `CLAUDE.md` (Known bugs + invariants sections)

**Interfaces:**
- Produces: tier assignments matching bot.md — Supporter: warn/timeout(+untimeout); Moderator: +ban/unban/kick/softban (removewarn already `moderator`); Owner: config/automod/setup unchanged. `src/loadCommands.js` maps these to Discord default perms automatically (supporter→ModerateMembers, moderator→BanMembers) — no change needed there.

- [ ] **Step 1: Change the tier lines**

In each file, the line is `requiredTier: 'moderator',` or `requiredTier: 'owner',`. Set:

| File | New value |
|---|---|
| warn.js, timeout.js, untimeout.js | `requiredTier: 'supporter',` |
| ban.js, unban.js, kick.js, softban.js | `requiredTier: 'moderator',` |

- [ ] **Step 2: Verify no `owner` remains on moderation commands**

Run: `grep -rn "requiredTier" src/commands/`
Expected: `owner` only on automod.js and config.js; supporter/moderator per the table; mute/unmute/slowmode/lockdown/unlock/cleanup/reason/removewarn/announcement stay `moderator`.

- [ ] **Step 3: Update CLAUDE.md** — in the "Critical invariants" section, replace the tier sentence with: warn/timeout/untimeout = supporter; ban/unban/kick/softban and other mod tools = moderator; config/automod/setup = owner. Remove the "tiers one level stricter than spec" bullet from Known bugs.

- [ ] **Step 4: Run** `npm test` → pass. (Command re-deploy happens automatically on next bot start.)

- [ ] **Step 5: Commit**

```bash
git add src/commands/ CLAUDE.md
git commit -m "fix: align command permission tiers with bot.md spec"
```

---

### Task 5: Gate autocomplete behind the command's tier

**Files:**
- Modify: `index.js` (autocomplete branch inside `InteractionCreate`, ~line 103)

**Interfaces:**
- Consumes: `perms.hasTier(guildId, member, tier)` (already imported as `perms` in index.js).
- Produces: unauthorized users receive an empty suggestion list; `/unban` ban-list and `/automod` wordlist no longer enumerable by everyone.

- [ ] **Step 1: Insert the gate**

In `index.js`, the autocomplete branch currently reads:

```js
    if (interaction.isAutocomplete()) {
      if (typeof command.autocomplete !== 'function') return;
      try {
        await command.autocomplete(interaction);
```

Change to:

```js
    if (interaction.isAutocomplete()) {
      if (typeof command.autocomplete !== 'function') return;
      if (command.requiredTier) {
        const allowed = await perms
          .hasTier(interaction.guildId, interaction.member, command.requiredTier)
          .catch(() => false);
        if (!allowed) {
          await interaction.respond([]).catch(() => {});
          return;
        }
      }
      try {
        await command.autocomplete(interaction);
```

- [ ] **Step 2: Run** `npm test` → pass.

- [ ] **Step 3: Manual verification note** — after deploy, with a non-mod account type `/unban target:` → suggestion list must stay empty.

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "fix: enforce command tier on autocomplete to stop ban-list/wordlist enumeration"
```

---

### Task 6: Crash-proofing (event handler catch, process handlers, partials)

**Files:**
- Modify: `src/loadEvents.js` (registration lines, ~line 26)
- Modify: `index.js` (client partials + process handlers)

**Interfaces:**
- Produces: no unhandled rejection can escape an event handler; `guildMemberRemove`/`guildMemberUpdate`/`userUpdate` fire for uncached members/users.

- [ ] **Step 1: Wrap handler execution in loadEvents.js**

Replace:

```js
    if (event.once) client.once(event.name, (...args) => event.execute(...args));
    else            client.on(event.name,   (...args) => event.execute(...args));
```

with:

```js
    const run = (...args) =>
      Promise.resolve(event.execute(...args)).catch((err) =>
        console.error(`[events] Handler ${file} (${String(event.name)}) failed:`, err),
      );
    if (event.once) client.once(event.name, run);
    else            client.on(event.name, run);
```

- [ ] **Step 2: Add process-level safety nets in index.js**

Directly after the `for (const [key, value] of Object.entries(required)) {...}` env-check loop, add:

```js
process.on('unhandledRejection', (err) => {
  console.error('[process] Unhandled promise rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught exception — exiting:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Add the missing partials**

Change:

```js
  partials: [Partials.Message],
```

to:

```js
  partials: [Partials.Message, Partials.GuildMember, Partials.User],
```

- [ ] **Step 4: Run** `npm test` → pass. Start check: `node -e "require('./src/loadEvents')"` exits silently.

- [ ] **Step 5: Commit**

```bash
git add src/loadEvents.js index.js
git commit -m "fix: catch event-handler rejections, add process handlers and missing partials"
```

---

### Task 7: Timezone-safe expiry (DB-side expires_at)

**Files:**
- Modify: `src/cases.js` (`createCase`)
- Modify: `src/commands/ban.js`, `src/commands/timeout.js`, `src/commands/mute.js`, `src/events/messageCreate.js`, `src/escalations.js` (~line 334), `src/interactions/report.js` (~line 354)
- Test: `tests/smoke/escalations.js` / `tests/smoke/modlog.js` may reference `expiresAt` — check in Step 4.

**Interfaces:**
- Produces: `createCase({ ..., expiresInMs })` — when `expiresInMs` (number|BigInt, ms) is set, `expires_at` is computed **in SQL** as `DATE_ADD(NOW(), INTERVAL ? SECOND)`, eliminating Node-vs-MySQL timezone skew. The legacy `expiresAt` (Date) param keeps working but no caller uses it afterwards.

- [ ] **Step 1: Extend createCase**

In `src/cases.js`, change the signature line to include the new param:

```js
async function createCase({
  guildId,
  userId,
  moderatorId,
  type,
  reason = null,
  durationMs = null,
  expiresAt = null,
  expiresInMs = null,
  source = 'manual',
  active = 1,
}) {
```

Replace the INSERT (step 4 in the function) with:

```js
    // 4. Infraction speichern. expires_at wird DB-seitig berechnet, damit
    //    Node- und MySQL-Zeitzone nie auseinanderlaufen können.
    const expiresSql = expiresInMs != null ? 'DATE_ADD(NOW(), INTERVAL ? SECOND)' : '?';
    const expiresParam = expiresInMs != null ? Math.round(Number(expiresInMs) / 1000) : expiresAt;
    const [result] = await conn.execute(
      `INSERT INTO infractions
         (guild_id, case_number, user_id, moderator_id, type, source, reason, duration_ms, expires_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${expiresSql}, ?)`,
      [guildId, caseNumber, userId, moderatorId, type, source, reason, durationMs, expiresParam, active],
    );
```

- [ ] **Step 2: Migrate the six call sites**

Uniform transformation — remove the local `expiresAt = new Date(Date.now() + durationMs)` value from the `createCase` call and pass `expiresInMs` instead. Example (ban.js):

```js
      const result = await cases.createCase({
        guildId: interaction.guildId,
        userId: target.id,
        moderatorId: moderator.id,
        type: 'ban',
        reason: interaction.options.getString('reason'),
        durationMs: durationMs ? BigInt(durationMs) : null,
        expiresInMs: durationMs,
      });
```

Apply identically in: timeout.js (`expiresAt: expiresAtDate` → `expiresInMs: durationMs`), mute.js, messageCreate.js (both the channel-hopping call and the toxicity-mute call: `expiresAt` → `expiresInMs: durationMs`), escalations.js (~line 334), interactions/report.js (~line 354). The `if (expiresAt)` revert checks from Task 3 still work — keep the local `expiresAt` variable assignments in ban.js/mute.js for that check (only stop *passing* it to createCase); in ban.js the reply text and Task 3 revert use it.

Find any leftovers: `grep -rn "expiresAt:" src/` → expected: no `createCase` call passes `expiresAt` anymore.

- [ ] **Step 3: Guard the revert checks** — confirm ban.js/mute.js still define `expiresAt = new Date(Date.now() + durationMs)` locally (used only for the Task 3 revert condition), or replace those conditions with `if (durationMs)` and delete the local Date entirely (preferred — do this: change both Task 3 conditions from `if (expiresAt)` to `if (durationMs)` and remove the `expiresAt` local variables).

- [ ] **Step 4: Run** `npm test`. If `tests/smoke/escalations.js` asserts on an `expiresAt` argument, update the assertion to `expiresInMs`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/cases.js src/commands/ban.js src/commands/timeout.js src/commands/mute.js src/events/messageCreate.js src/escalations.js src/interactions/report.js tests/
git commit -m "fix: compute expires_at in SQL to remove timezone skew on temp punishments"
```

---

### Task 8: Background loop re-entrancy guard

**Files:**
- Modify: `src/background.js` (`startBackgroundTasks`, file end)

- [ ] **Step 1: Add the guard**

Replace `startBackgroundTasks` with:

```js
function startBackgroundTasks(client) {
  console.log('[background] Starting background checks loop (60s interval)...');
  let running = false;
  setInterval(async () => {
    if (running) return; // vorheriger Lauf noch aktiv — Doppelverarbeitung verhindern
    running = true;
    try {
      await runDecayAndExpiry(client);
    } catch (err) {
      console.error('[background] Uncaught error in runDecayAndExpiry interval loop:', err);
    } finally {
      running = false;
    }
  }, 60000);
}
```

- [ ] **Step 2: Run** `npm test` → pass.

- [ ] **Step 3: Commit**

```bash
git add src/background.js
git commit -m "fix: prevent overlapping background expiry runs"
```

---

### Task 9: Channel-hopping — guild-scoped keys + memory pruning

**Files:**
- Modify: `src/events/messageCreate.js` (`channelHoppingHistory` handling, top of file + `checkChannelHopping`)
- Test: `tests/smoke/channel_hopping.js` (check/update key expectations)

**Interfaces:**
- Produces: history keyed by `` `${guildId}:${userId}` ``; stale entries evicted by a 60s sweep so the Map no longer retains Message objects indefinitely.

- [ ] **Step 1: Scope the key and add the sweeper**

In `src/events/messageCreate.js`, after the constants block at the top, add:

```js
// Periodic sweep: entferne abgelaufene Einträge, damit die Map nicht unbegrenzt
// Message-Objekte von Usern hält, die nie wieder schreiben.
setInterval(() => {
  const cutoff = Date.now() - HOPPING_TIMEFRAME_MS;
  for (const [key, history] of channelHoppingHistory) {
    const pruned = history.filter((h) => h.timestamp >= cutoff);
    if (pruned.length === 0) channelHoppingHistory.delete(key);
    else channelHoppingHistory.set(key, pruned);
  }
}, 60_000).unref?.();
```

In `checkChannelHopping`, replace every use of the key:

```js
  const historyKey = `${guildId}:${userId}`;

  let history = channelHoppingHistory.get(historyKey);
  if (!history) {
    history = [];
    channelHoppingHistory.set(historyKey, history);
  }
```

…and further down replace `channelHoppingHistory.set(userId, history);` with `channelHoppingHistory.set(historyKey, history);` and `channelHoppingHistory.delete(userId);` with `channelHoppingHistory.delete(historyKey);` (`guildId` is already defined at the top of the function).

- [ ] **Step 2: Check the smoke test**

Run: `node tests/smoke/channel_hopping.js`
If it fails because it seeds the Map with bare-userId keys, update the test to use `` `${guildId}:${userId}` `` keys to mirror the new scheme. Expected afterwards: pass.

- [ ] **Step 3: Run** `npm test` → all pass.

- [ ] **Step 4: Commit**

```bash
git add src/events/messageCreate.js tests/smoke/channel_hopping.js
git commit -m "fix: guild-scope channel-hopping detection and prune stale history"
```

---

### Task 10: Captcha — server-side answers, no attempt reset

**Files:**
- Modify: `src/interactions/captcha.js` (puzzle generation + dispatch)
- Test: Create `tests/smoke/captcha_answers.js`

**Interfaces:**
- Consumes: `config.getVerifiedRoleIds/getUnverifiedRoleIds/getJoinRoleIds/getCaptchaChannelId/getModLogChannelId` (unchanged).
- Produces: buttons carry `captcha_pick_<userId>_<index>` (no answer leak); module exports `{ dispatch, _internal: { generatePuzzle, pendingPuzzles } }`; Task 11 hooks the solve/kick paths (`markVerified`).

- [ ] **Step 1: Write the failing smoke test**

Create `tests/smoke/captcha_answers.js`:

```js
// Run with: node tests/smoke/captcha_answers.js
const assert = require('node:assert/strict');
const { _internal } = require('../../src/interactions/captcha');

assert.ok(_internal, 'captcha module must export _internal for tests');
const { generatePuzzle, pendingPuzzles } = _internal;

const payload = generatePuzzle('guild1', 'user1', 1);
const row = payload.components[0];
for (const button of row.components) {
  const id = button.data.custom_id;
  assert.ok(!id.includes('correct'), `customId leaks answer: ${id}`);
  assert.ok(!id.includes('wrong'), `customId leaks answer: ${id}`);
  assert.match(id, /^captcha_pick_user1_\d$/, `unexpected customId format: ${id}`);
}

const entry = pendingPuzzles.get('guild1:user1');
assert.ok(entry, 'pending puzzle stored server-side');
assert.equal(entry.attempt, 1);
assert.ok(entry.options.includes(entry.correctEmoji), 'correct emoji among options');
assert.ok(entry.expiresAt > Date.now(), 'entry has TTL');

// Attempt count survives a re-generated puzzle (anti reset-exploit)
generatePuzzle('guild1', 'user1', 3);
assert.equal(pendingPuzzles.get('guild1:user1').attempt, 3);

pendingPuzzles.clear();
console.log('OK — captcha answers are server-side');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/smoke/captcha_answers.js`
Expected: AssertionError (`_internal` undefined).

- [ ] **Step 3: Rewrite puzzle generation in src/interactions/captcha.js**

Replace the existing `generatePuzzle` function with:

```js
// Server-seitiger Puzzle-Zustand: `${guildId}:${userId}` → { correctEmoji, options, attempt, expiresAt }
// Die Antwort darf NIE in der customId stehen — Selfbots lesen den Component-Payload.
const pendingPuzzles = new Map();
const PUZZLE_TTL_MS = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pendingPuzzles) {
    if (entry.expiresAt <= now) pendingPuzzles.delete(key);
  }
}, 5 * 60 * 1000).unref?.();

function generatePuzzle(guildId, userId, attempt) {
  const targetIndex = Math.floor(Math.random() * EMOJIS.length);
  const target = EMOJIS[targetIndex];

  const decoys = EMOJIS.filter((_, idx) => idx !== targetIndex)
    .sort(() => 0.5 - Math.random())
    .slice(0, 4);

  const options = [target, ...decoys].sort(() => 0.5 - Math.random());

  pendingPuzzles.set(`${guildId}:${userId}`, {
    correctEmoji: target.emoji,
    options: options.map((o) => o.emoji),
    attempt,
    expiresAt: Date.now() + PUZZLE_TTL_MS,
  });

  const embed = new EmbedBuilder()
    .setTitle(`🔐 Captcha-Verifizierung (Versuch ${attempt}/3)`)
    .setColor(0xf1c40f)
    .setDescription(`Bitte klicke auf das Emoji, welches folgendes Symbol darstellt:\n\n👉 **${target.name}** 👈`)
    .setFooter({ text: '🐾 Oreo • Captcha' })
    .setTimestamp();

  const row = new ActionRowBuilder();
  options.forEach((option, index) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`captcha_pick_${userId}_${index}`)
        .setLabel(option.emoji)
        .setStyle(ButtonStyle.Secondary)
    );
  });

  return { embeds: [embed], components: [row] };
}
```

- [ ] **Step 4: Rewrite the dispatch answer path**

In `dispatch`, update the three call sites of `generatePuzzle` to pass the guild id, and preserve attempts on (re)start:

`captcha_global_start` handler — replace `const puzzle = generatePuzzle(interaction.user.id, 1);` with:

```js
    const existing = pendingPuzzles.get(`${interaction.guild.id}:${interaction.user.id}`);
    const attempt = existing && existing.expiresAt > Date.now() ? existing.attempt : 1;
    const puzzle = generatePuzzle(interaction.guild.id, interaction.user.id, attempt);
```

`start` (per-user) handler — replace `const puzzle = generatePuzzle(targetUserId, 1);` and the `ephemeral: false` reply with:

```js
  if (action === 'start') {
    const existing = pendingPuzzles.get(`${guild.id}:${targetUserId}`);
    const attempt = existing && existing.expiresAt > Date.now() ? existing.attempt : 1;
    const puzzle = generatePuzzle(guild.id, targetUserId, attempt);
    await interaction.reply(puzzle);
    return true;
  }
```

Then replace the entire `const attempt = parseInt(parts[3], 10) || 1;` line and the two `if (action === 'correct')` / `if (action === 'wrong')` blocks with a single `pick` block. The body of the old `correct`/`wrong` branches is reused verbatim — only the outer decision changes:

```js
  if (action === 'pick') {
    const key = `${guild.id}:${targetUserId}`;
    const entry = pendingPuzzles.get(key);

    if (!entry || entry.expiresAt <= Date.now()) {
      pendingPuzzles.delete(key);
      await interaction.reply({
        content: '⏳ Dieses Captcha ist abgelaufen. Bitte starte die Verifizierung neu.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => null);
      return true;
    }

    const pickedIndex = parseInt(parts[3], 10);
    const pickedEmoji = entry.options[pickedIndex];
    const attempt = entry.attempt;

    if (pickedEmoji === entry.correctEmoji) {
      pendingPuzzles.delete(key);
      // === bisheriger 'correct'-Zweig unverändert hier einfügen ===
    } else {
      if (attempt < 3) {
        const puzzle = generatePuzzle(guild.id, targetUserId, attempt + 1);
        await interaction.update({
          content: '❌ Falsches Emoji! Versuche es noch einmal.',
          ...puzzle,
        });
      } else {
        pendingPuzzles.delete(key);
        // === bisheriger 'wrong'-Zweig (attempt >= 3: deferUpdate + kick + modlog + channel cleanup) unverändert hier einfügen ===
      }
    }
    return true;
  }
```

Note: `parts` still comes from `customId.split('_')` → `['captcha','pick','<userId>','<index>']`, so `parts[1]==='pick'`, `parts[2]` user id (existing "nicht für dich gedacht" guard keeps working), `parts[3]` index.

- [ ] **Step 5: Export internals**

Change the module export to:

```js
module.exports = { dispatch, _internal: { generatePuzzle, pendingPuzzles } };
```

- [ ] **Step 6: Run tests**

Run: `node tests/smoke/captcha_answers.js` → `OK — captcha answers are server-side`.
Run: `npm test` → all pass (including existing `captcha_and_toxicity.js`; if it asserts on `captcha_correct_`/`captcha_wrong_` customIds, update it to the `captcha_pick_` scheme with a seeded `pendingPuzzles` entry).

- [ ] **Step 7: Commit**

```bash
git add src/interactions/captcha.js tests/smoke/captcha_answers.js tests/smoke/captcha_and_toxicity.js
git commit -m "fix: store captcha answers server-side and preserve attempt count"
```

---

### Task 11: Persistent verification deadlines (restart-safe kick, no false kicks)

**Files:**
- Create: `src/verifications.js`
- Modify: `server/schema.sql` (append table)
- Modify: `src/events/guildMemberAdd.js` (replace the 15-min `setTimeout` block)
- Modify: `src/interactions/captcha.js` (solve + kick paths)
- Modify: `src/background.js` (sweep in `runDecayAndExpiry`)
- Test: Create `tests/smoke/verifications.js`

**Interfaces:**
- Produces (module `src/verifications.js`):
  - `trackJoin(guildId, userId, channelId|null, minutes)` → upsert row, deadline computed in SQL
  - `markVerified(guildId, userId)` → deletes the row (also called on captcha-fail kick)
  - `listExpired()` → rows past deadline
  - `remove(guildId, userId)` → delete row
- A user who **solved** the captcha can never be kicked by the deadline sweep (row gone), even if role assignment failed. Deadlines survive restarts.

- [ ] **Step 1: Add the table to server/schema.sql (append at end of file)**

```sql
-- Offene Captcha-Verifizierungen (überlebt Bot-Restarts; Sweep im Background-Loop)
CREATE TABLE IF NOT EXISTS pending_verifications (
  guild_id    BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  channel_id  BIGINT UNSIGNED NULL,
  deadline_at DATETIME NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (guild_id, user_id),
  INDEX idx_deadline (deadline_at)
);
```

- [ ] **Step 2: Write the failing smoke test**

Create `tests/smoke/verifications.js` (DB-backed, like other suites — `tests/run.js` ensures the schema first):

```js
// Run with: node tests/smoke/verifications.js  (braucht MySQL aus .env)
const assert = require('node:assert/strict');

async function main() {
  const v = require('../../src/verifications');
  const { getPool } = require('../../src/db');
  const G = '999999999999999901', U = '999999999999999902';

  await getPool().execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [G]);
  await v.remove(G, U);

  await v.trackJoin(G, U, null, 15);
  let [rows] = await getPool().execute(
    'SELECT * FROM pending_verifications WHERE guild_id = ? AND user_id = ?', [G, U]);
  assert.equal(rows.length, 1, 'trackJoin inserts row');

  // Deadline in die Vergangenheit setzen → muss in listExpired auftauchen
  await getPool().execute(
    'UPDATE pending_verifications SET deadline_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE guild_id = ? AND user_id = ?',
    [G, U]);
  const expired = await v.listExpired();
  assert.ok(expired.some(r => String(r.guild_id) === G && String(r.user_id) === U), 'expired row listed');

  await v.markVerified(G, U);
  [rows] = await getPool().execute(
    'SELECT * FROM pending_verifications WHERE guild_id = ? AND user_id = ?', [G, U]);
  assert.equal(rows.length, 0, 'markVerified removes row');

  console.log('OK — verifications DAL passed');
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 3: Run it to verify it fails** — `node tests/smoke/verifications.js` → "Cannot find module '../../src/verifications'".

- [ ] **Step 4: Implement src/verifications.js**

```js
const { getPool } = require('./db');

/** Merkt einen unverifizierten Join vor. Deadline wird DB-seitig berechnet. */
async function trackJoin(guildId, userId, channelId, minutes) {
  await getPool().execute(
    `INSERT INTO pending_verifications (guild_id, user_id, channel_id, deadline_at)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))
     ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), deadline_at = VALUES(deadline_at)`,
    [guildId, userId, channelId, minutes],
  );
}

/** Entfernt den Pending-Eintrag (Captcha gelöst ODER User gekickt/weg). */
async function markVerified(guildId, userId) {
  await getPool().execute(
    'DELETE FROM pending_verifications WHERE guild_id = ? AND user_id = ?',
    [guildId, userId],
  );
}

const remove = markVerified;

/** Alle Einträge, deren Deadline überschritten ist. */
async function listExpired() {
  const [rows] = await getPool().execute(
    'SELECT guild_id, user_id, channel_id FROM pending_verifications WHERE deadline_at < NOW()',
  );
  return rows;
}

module.exports = { trackJoin, markVerified, remove, listExpired };
```

- [ ] **Step 5: Run the test** — `node tests/smoke/verifications.js` → `OK — verifications DAL passed`.

- [ ] **Step 6: Replace the setTimeout in guildMemberAdd.js**

Add at the top of the file: `const verifications = require('../verifications');`

Delete the entire `setTimeout(async () => { ... }, 15 * 60 * 1000);` block (the 15-min kick timer) and replace it with:

```js
      // Restart-sicher: Deadline in DB, Sweep läuft im Background-Loop.
      await verifications.trackJoin(
        guildId,
        member.id,
        isGlobal ? null : verifyChannel?.id ?? null,
        15,
      );
```

- [ ] **Step 7: Hook the captcha paths**

In `src/interactions/captcha.js` add `const verifications = require('../verifications');` at the top. In the solve path (Task 10 `pick` handler, correct branch) insert as the **first** action after `pendingPuzzles.delete(key);`:

```js
      await verifications.markVerified(guild.id, targetUserId).catch((err) =>
        console.error('[captcha] markVerified failed:', err));
```

In the 3-fails kick branch, after the `member.kick(...)` call, add:

```js
      await verifications.remove(guild.id, targetUserId).catch(() => null);
```

- [ ] **Step 8: Add the sweep to background.js**

Add at the top: `const verifications = require('./verifications');`

At the end of `runDecayAndExpiry` (after the warn-decay block), append:

```js
  // 4. Abgelaufene Captcha-Verifizierungen (restart-sicher, ersetzt setTimeout)
  try {
    const expired = await verifications.listExpired();
    for (const row of expired) {
      const guildId = row.guild_id.toString();
      const userId = row.user_id.toString();
      const guild = await client.guilds.fetch(guildId).catch(() => null);

      if (guild) {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member) {
          await member.kick('Oreo: Verifizierung abgelaufen').catch((err) =>
            console.error(`[background] Verification kick failed for ${userId}:`, err));
          try {
            const logChannelId = await config.getModLogChannelId(guildId);
            if (logChannelId) {
              const logChannel = await guild.channels.fetch(logChannelId).catch(() => null);
              if (logChannel) {
                await logChannel.send({
                  content: `⏳ Verifizierung abgelaufen: <@${userId}> wurde gekickt.`,
                }).catch(() => null);
              }
            }
          } catch (logErr) {
            console.warn('[background] Verification-kick modlog failed:', logErr);
          }
        }
        if (row.channel_id) {
          const chan = await guild.channels.fetch(row.channel_id.toString()).catch(() => null);
          if (chan) await chan.delete('Oreo: Verifizierung abgelaufen').catch(() => null);
        }
      }
      await verifications.remove(guildId, userId);
    }
  } catch (err) {
    console.error('[background] Error processing expired verifications:', err);
  }
```

- [ ] **Step 9: Run** `npm test` → all pass (incl. the new suite).

- [ ] **Step 10: Commit**

```bash
git add server/schema.sql src/verifications.js src/events/guildMemberAdd.js src/interactions/captcha.js src/background.js tests/smoke/verifications.js
git commit -m "feat: persist verification deadlines in DB; solved users can never be deadline-kicked"
```

---

### Task 12: Anti-raid — one shared verify channel instead of one per joiner

**Files:**
- Create: `src/composables/verifyChannel.js`
- Modify: `src/events/guildMemberAdd.js` (the `if (!isGlobal) { ...channels.create... }` block)
- Modify: `src/config.js` **only if** `setCaptchaChannelId` does not already exist (check in Step 1)

**Interfaces:**
- Consumes: `config.getCaptchaChannelId/setCaptchaChannelId`, `verifications.trackJoin` (Task 11), customId `captcha_global_start` (already handled by captcha.js).
- Produces: `getOrCreateSharedVerifyChannel(guild)` → TextChannel; concurrent joins during a raid share one creation promise (no channel flood).

- [ ] **Step 1: Check for the setter**

Run: `grep -n "setCaptchaChannelId" src/config.js`
If missing, add next to `getCaptchaChannelId` (mirroring `setVerifiedRoleId`):

```js
/** Setzt den Kanal für die globale Captcha-Verifizierung. */
async function setCaptchaChannelId(guildId, channelId) {
  await getPool().execute(
    'UPDATE guilds SET captcha_channel_id = ? WHERE guild_id = ?',
    [channelId || null, guildId],
  );
}
```

…and add `setCaptchaChannelId,` to the `module.exports` block.

- [ ] **Step 2: Implement src/composables/verifyChannel.js**

```js
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ChannelType } = require('discord.js');
const config = require('../config');

// Ein Erstellungs-Promise pro Guild: verhindert, dass ein Raid mit N Joins
// N parallele Channel-Erstellungen auslöst.
const creating = new Map();

async function getOrCreateSharedVerifyChannel(guild) {
  const existingId = await config.getCaptchaChannelId(guild.id);
  if (existingId) {
    const existing = await guild.channels.fetch(existingId).catch(() => null);
    if (existing) return existing;
  }

  if (creating.has(guild.id)) return creating.get(guild.id);

  const promise = (async () => {
    const channel = await guild.channels.create({
      name: 'oreo-verify',
      type: ChannelType.GuildText,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          allow: ['ViewChannel', 'ReadMessageHistory'],
          deny: ['SendMessages', 'AddReactions', 'CreatePublicThreads', 'CreatePrivateThreads'],
        },
        {
          id: guild.client.user.id,
          allow: ['ViewChannel', 'SendMessages', 'ManageChannels', 'ManageRoles', 'ReadMessageHistory'],
        },
      ],
      reason: 'Oreo: Gemeinsamer Verifizierungs-Kanal',
    });

    const embed = new EmbedBuilder()
      .setTitle('🔐 Server-Verifizierung')
      .setColor(0x3498db)
      .setDescription('Willkommen! Um den Server freizuschalten, klicke auf den Button und löse das Captcha.')
      .setFooter({ text: '🐾 Oreo • Verifizierung' })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('captcha_global_start')
        .setLabel('Verifizierung starten')
        .setStyle(ButtonStyle.Primary),
    );

    await channel.send({ embeds: [embed], components: [row] });
    await config.setCaptchaChannelId(guild.id, channel.id);
    return channel;
  })().finally(() => creating.delete(guild.id));

  creating.set(guild.id, promise);
  return promise;
}

module.exports = { getOrCreateSharedVerifyChannel };
```

- [ ] **Step 3: Replace the per-user channel block in guildMemberAdd.js**

Add at the top: `const { getOrCreateSharedVerifyChannel } = require('../composables/verifyChannel');`

Replace the entire `if (!isGlobal) { verifyChannel = await member.guild.channels.create({ ... }); ... await verifyChannel.send({...}); }` block with:

```js
      if (!isGlobal) {
        // Kein Captcha-Kanal konfiguriert → EIN geteilter Kanal für alle
        // (pro-User-Kanäle haben Raids in ein Rate-Limit-DoS verwandelt).
        verifyChannel = await getOrCreateSharedVerifyChannel(member.guild);
        await member.send({
          content: `Willkommen auf **${member.guild.name}**! Bitte verifiziere dich in <#${verifyChannel.id}>, um vollen Zugriff zu erhalten.`,
        }).catch(() => {});
      }
```

Then update the Task 11 `trackJoin` call in the same function: the shared channel must never be deleted by the sweep, so pass `null` as channel id in **all** cases:

```js
      await verifications.trackJoin(guildId, member.id, null, 15);
```

(Remove the `isGlobal ? null : verifyChannel?.id ?? null` variant from Task 11 Step 6.)

- [ ] **Step 4: Run** `npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/composables/verifyChannel.js src/events/guildMemberAdd.js src/config.js
git commit -m "fix: shared verify channel with creation dedup replaces per-joiner channels"
```

---

### Task 13: Speech privacy — no transcription while voice-rec is disabled

**Files:**
- Modify: `src/commands/voice.js` (join subcommand)
- Modify: `src/events/speech.js` (disabled path)

**Interfaces:**
- Consumes: `config.getVoiceRecEnabled(guildId)`, `getVoiceConnection` from `@discordjs/voice`.
- Produces: the bot only sits in a VC (and therefore only streams audio to the STT backend) while `voice_rec_enabled` is on; disabling the config self-heals by destroying the connection on the next utterance.

- [ ] **Step 1: Gate /voice join**

In `src/commands/voice.js` add at the top: `const config = require('../config');`

At the start of the `if (sub === 'join') {` block (before the `voiceChannel` lookup), insert:

```js
      const recEnabled = await config.getVoiceRecEnabled(interaction.guildId);
      if (!recEnabled) {
        return interaction.reply({
          content: '❌ Voice-Recognition ist für diesen Server deaktiviert. Ein Admin kann sie über `/config voice` aktivieren. Solange sie aus ist, trete ich keinem Voice-Kanal bei (Datenschutz: Audio würde zur Spracherkennung an einen externen Dienst gestreamt).',
          flags: MessageFlags.Ephemeral,
        });
      }
```

- [ ] **Step 2: Self-heal in speech.js**

Replace in `src/events/speech.js`:

```js
      const enabled = await config.getVoiceRecEnabled(guildId);
      if (!enabled) return;
```

with:

```js
      const enabled = await config.getVoiceRecEnabled(guildId);
      if (!enabled) {
        // Feature wurde deaktiviert, Bot hängt aber noch im VC → Verbindung
        // trennen, damit kein weiteres Audio zur Spracherkennung gestreamt wird.
        const { getVoiceConnection } = require('@discordjs/voice');
        getVoiceConnection(guildId)?.destroy();
        return;
      }
```

- [ ] **Step 3: Run** `npm test` (voice_rec suite must still pass) → all pass.

- [ ] **Step 4: Commit**

```bash
git add src/commands/voice.js src/events/speech.js
git commit -m "fix: keep bot out of voice while voice-rec is disabled (privacy)"
```

---

### Task 14: Speech hardening — word matching, confirmation, case records

**Files:**
- Create: `src/interactions/voiceconfirm.js`
- Modify: `src/events/speech.js` (matching + destructive paths)
- Modify: `index.js` (dispatcher chain)

**Interfaces:**
- Consumes: `perms.hasTier`, `cases.createCase` (with `expiresInMs` from Task 7), `config.getModLogChannelId`, `buildModLogEmbed`.
- Produces: `voiceconfirm.requestConfirmation({ textChannel, voiceChannel, requester, action, targetMember })` posts a button prompt; `voiceconfirm.dispatch(interaction)` handles `voiceconfirm:` buttons. Speech commands now match **whole words directly after "oreo"**; lockdown and mute require button confirmation; confirmed voice-mutes write a case + modlog entry.

- [ ] **Step 1: Implement src/interactions/voiceconfirm.js**

```js
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const perms = require('../perms');
const cases = require('../cases');
const config = require('../config');
const { buildModLogEmbed } = require('../modlog');

// pendingId → { action: 'lockdown'|'mute', guildId, voiceChannelId, requesterId, targetId|null, expiresAt }
const pending = new Map();
const CONFIRM_TTL_MS = 60 * 1000;
let nextId = 1;

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(id);
  }
}, 60 * 1000).unref?.();

/** Postet eine Bestätigungs-Anfrage für eine destruktive Sprach-Aktion. */
async function requestConfirmation({ textChannel, voiceChannel, requester, action, targetMember = null }) {
  const id = String(nextId++);
  pending.set(id, {
    action,
    guildId: voiceChannel.guild.id,
    voiceChannelId: voiceChannel.id,
    requesterId: requester.id,
    targetId: targetMember?.id ?? null,
    expiresAt: Date.now() + CONFIRM_TTL_MS,
  });

  const label = action === 'lockdown'
    ? `🔒 Voice-Lockdown für **${voiceChannel.name}** (alle Nicht-Team-Mitglieder werden gemutet)`
    : `🔇 5-Minuten-Timeout für <@${targetMember.id}>`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`voiceconfirm:ok:${id}`).setLabel('Bestätigen').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`voiceconfirm:no:${id}`).setLabel('Abbrechen').setStyle(ButtonStyle.Secondary),
  );

  await textChannel.send({
    content: `🐾 <@${requester.id}> hat per Sprachbefehl angefordert: ${label}\nBestätige innerhalb von 60 Sekunden.`,
    components: [row],
  });
}

async function dispatch(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('voiceconfirm:')) return false;

  const [, verb, id] = interaction.customId.split(':');
  const entry = pending.get(id);

  if (!entry || entry.expiresAt <= Date.now()) {
    await interaction.update({ content: '⏳ Diese Bestätigung ist abgelaufen.', components: [] }).catch(() => null);
    return true;
  }

  // Nur Anforderer oder Team (Supporter+) darf klicken.
  const isRequester = interaction.user.id === entry.requesterId;
  const isStaff = await perms.hasTier(entry.guildId, interaction.member, 'supporter').catch(() => false);
  if (!isRequester && !isStaff) {
    await interaction.reply({ content: '❌ Diese Bestätigung ist nicht für dich.', flags: MessageFlags.Ephemeral }).catch(() => null);
    return true;
  }

  pending.delete(id);

  if (verb === 'no') {
    await interaction.update({ content: '✅ Aktion abgebrochen.', components: [] }).catch(() => null);
    return true;
  }

  const guild = interaction.guild;
  const voiceChannel = await guild.channels.fetch(entry.voiceChannelId).catch(() => null);
  if (!voiceChannel) {
    await interaction.update({ content: '❌ Voice-Kanal nicht mehr gefunden.', components: [] }).catch(() => null);
    return true;
  }

  if (entry.action === 'lockdown') {
    await voiceChannel.permissionOverwrites.edit(guild.roles.everyone, { Speak: false }).catch(() => {});
    let mutedCount = 0;
    for (const m of voiceChannel.members.values()) {
      if (m.user.bot) continue;
      const targetIsStaff = await perms.hasTier(entry.guildId, m, 'supporter').catch(() => false);
      if (!targetIsStaff) {
        await m.voice.setMute(true, 'Oreo Sprach-Lockdown (bestätigt)').catch(() => {});
        mutedCount++;
      }
    }
    await interaction.update({
      content: `🔒 **Voice-Lockdown** in **${voiceChannel.name}** durch <@${entry.requesterId}> bestätigt. ${mutedCount} User gemutet. Aufheben mit "Oreo unlock".`,
      components: [],
    }).catch(() => null);
    return true;
  }

  if (entry.action === 'mute') {
    const targetMember = await guild.members.fetch(entry.targetId).catch(() => null);
    if (!targetMember) {
      await interaction.update({ content: '❌ Ziel-User nicht mehr auf dem Server.', components: [] }).catch(() => null);
      return true;
    }
    const durationMs = 5 * 60 * 1000;
    await targetMember.timeout(durationMs, `Sprach-Mute durch ${interaction.user.tag} (bestätigt)`).catch(() => {});
    await targetMember.voice.setMute(true, `Sprach-Mute durch ${interaction.user.tag}`).catch(() => {});

    let caseNumber = null;
    try {
      const result = await cases.createCase({
        guildId: entry.guildId,
        userId: targetMember.id,
        moderatorId: entry.requesterId,
        type: 'timeout',
        reason: 'Sprachbefehl: Voice-Mute (5 Minuten)',
        durationMs: BigInt(durationMs),
        expiresInMs: durationMs,
      });
      caseNumber = result.caseNumber;
    } catch (err) {
      console.error('[voiceconfirm] createCase failed:', err);
    }

    try {
      const channelId = await config.getModLogChannelId(entry.guildId);
      if (channelId) {
        const logChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (logChannel) {
          const embed = buildModLogEmbed({
            action: 'timeout',
            caseNumber,
            target: targetMember.user,
            mod: interaction.user,
            reason: 'Sprachbefehl: Voice-Mute',
            durationMs,
          });
          if (embed) await logChannel.send({ embeds: [embed] }).catch(() => null);
        }
      }
    } catch (logErr) {
      console.warn('[voiceconfirm] modlog failed:', logErr);
    }

    await interaction.update({
      content: `🔇 <@${targetMember.id}> wurde für 5 Minuten stummgeschaltet (Case #${caseNumber ?? '—'}).`,
      components: [],
    }).catch(() => null);
    return true;
  }

  return true;
}

module.exports = { dispatch, requestConfirmation };
```

- [ ] **Step 2: Register the dispatcher in index.js**

Add import next to the other interaction modules:

```js
const voiceConfirmInteractions = require('./src/interactions/voiceconfirm');
```

Extend the dispatch chain:

```js
      const handled = await reportInteractions.dispatch(interaction)
                   || await announcementInteractions.dispatch(interaction)
                   || await captchaInteractions.dispatch(interaction)
                   || await welcomeInteractions.dispatch(interaction)
                   || await voiceConfirmInteractions.dispatch(interaction);
```

- [ ] **Step 3: Rewrite the matching in speech.js**

After `const cleanText = msg.content.toLowerCase().trim();`, replace the `hasOreo` check and **all five** command blocks. New matching preamble:

```js
      // Wortbasiertes Matching: Befehl muss ein eigenes Wort DIREKT nach "oreo"
      // sein — "Oreo Banane" darf nicht mehr als "ban" zählen.
      const words = cleanText.split(/[^a-zäöüß0-9-]+/).filter(Boolean);
      const oreoIdx = words.indexOf('oreo');
      if (oreoIdx === -1) return;
      const cmd = words[oreoIdx + 1] ?? '';
      const rest = words.slice(oreoIdx + 2);
```

Then the five branches become:

```js
      const voiceConfirm = require('../interactions/voiceconfirm');

      // 1. Meme-Reply
      if (['ban', 'bann', 'band', 'oreoban'].includes(cmd)) {
        const targetChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (targetChannel) {
          const responseMessage = await config.getVoiceRecMessage(guildId);
          await targetChannel.send(responseMessage);
        }
        return;
      }

      // 2. Support-Ruf
      if (['hilf', 'hilfe', 'support', 'supporter'].includes(cmd)) {
        const targetChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (targetChannel) {
          await targetChannel.send(`🚨 **Voice Support-Ruf:** <@${msg.author.id}> (${msg.author.tag}) benötigt Hilfe im Sprachkanal **${msg.channel.name}**!`);
          await msg.channel.send(`🐾 Oreo hat dich gehört, <@${msg.author.id}>. Ich habe das Team alarmiert!`);
        }
        return;
      }

      // 3. Lockdown — destruktiv → Button-Bestätigung
      if (['lockdown', 'ruhe'].includes(cmd)) {
        if (!isStaff) {
          await msg.channel.send(`❌ <@${msg.author.id}>, dir fehlt das Supporter-Tier für diesen Befehl.`);
          return;
        }
        const targetChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (targetChannel) {
          await voiceConfirm.requestConfirmation({
            textChannel: targetChannel,
            voiceChannel: msg.channel,
            requester: msg.author,
            action: 'lockdown',
          });
        }
        return;
      }

      // 4. Unlock — restaurativ, bleibt direkt
      if (['unlock', 'aufheben'].includes(cmd)) {
        if (!isStaff) {
          await msg.channel.send(`❌ <@${msg.author.id}>, dir fehlt das Supporter-Tier für diesen Befehl.`);
          return;
        }
        await msg.channel.permissionOverwrites.edit(guild.roles.everyone, { Speak: null }).catch(() => {});
        for (const m of msg.channel.members.values()) {
          await m.voice.setMute(false, 'Oreo Sprach-Unlock').catch(() => {});
        }
        await msg.channel.send(`🔓 **Voice-Unlock:** Sprachkanal wurde durch <@${msg.author.id}> wieder freigegeben.`);
        return;
      }

      // 5. Voice-Mute — destruktiv → Button-Bestätigung
      if (['mute', 'stumm', 'stummschalten', 'timeout'].includes(cmd)) {
        if (!isStaff) {
          await msg.channel.send(`❌ <@${msg.author.id}>, dir fehlt das Supporter-Tier für diesen Befehl.`);
          return;
        }
        const namePart = rest.join(' ').trim();
        if (namePart.length < 2) {
          await msg.channel.send(`❓ Bitte nenne einen Namen (z. B. "Oreo mute Lukas").`);
          return;
        }
        const vcMembers = [...msg.channel.members.values()];
        const targetMember = vcMembers.find((m) =>
          m.displayName.toLowerCase().includes(namePart) ||
          m.user.username.toLowerCase().includes(namePart)
        );
        if (!targetMember) {
          await msg.channel.send(`❓ Ich konnte kein Mitglied namens "${namePart}" im Sprachkanal finden.`);
          return;
        }
        const targetIsStaff = await perms.hasTier(guildId, targetMember, 'supporter');
        if (targetIsStaff) {
          await msg.channel.send(`❌ <@${msg.author.id}>, ich kann andere Teammitglieder nicht stummschalten!`);
          return;
        }
        const targetChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (targetChannel) {
          await voiceConfirm.requestConfirmation({
            textChannel: targetChannel,
            voiceChannel: msg.channel,
            requester: msg.author,
            action: 'mute',
            targetMember,
          });
        }
        return;
      }
```

(The `isStaff` computation stays where it is, before the branches. Everything after the old branch 5 — the closing catch — is unchanged.)

- [ ] **Step 4: Run** `npm test`. The `voice_rec.js` suite mocks speech events — if it asserts the old substring behavior (e.g. "Oreo Banane" triggers ban reply), update it: "oreo ban" must trigger, "oreo banane" must NOT. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/interactions/voiceconfirm.js src/events/speech.js index.js tests/smoke/voice_rec.js
git commit -m "feat: word-boundary voice commands with button confirmation and case records"
```

---

### Task 15: guild_users.level schema drift fix

**Files:**
- Modify: `server/schema.sql` (guild_users CREATE + staged ALTER)

**Interfaces:**
- Produces: `guild_users.level` exists on standalone Oreo databases; `perms.getEffectiveTier`'s level query stops erroring outside the shared Ramen DB. (On the shared DB the ALTER is a no-op — errno 1060 is swallowed by `src/schema.js`.)

- [ ] **Step 1: Add the column**

In `server/schema.sql`, add to the `CREATE TABLE IF NOT EXISTS guild_users` definition after the `currency` line:

```sql
  level       INT UNSIGNED NULL,
```

And append near the other staged ALTERs at the bottom (before the `pending_verifications` table from Task 11):

```sql
ALTER TABLE guild_users ADD COLUMN level INT UNSIGNED NULL;
```

- [ ] **Step 2: Verify** — `npm test` (ensureSchema replays the file; 1060 swallow makes it idempotent). Expected: all pass, and on a fresh DB `SELECT level FROM guild_users` no longer errors — the CI workflow (fresh MySQL service) is the real proof on push.

- [ ] **Step 3: Commit**

```bash
git add server/schema.sql
git commit -m "fix: add guild_users.level so tier checks work on standalone databases"
```

---

### Task 16: Update CLAUDE.md and finish the branch

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md** per its maintenance rule:
  - Invariants: new duration units (`s/m/h/t/d/w`, 365-day temp cap), autocomplete now tier-gated, captcha answers server-side (in-memory `pendingPuzzles`), verification deadlines in `pending_verifications` (background sweep, restart-safe), shared `oreo-verify` channel, `voiceconfirm:` dispatcher in the component chain, `createCase` takes `expiresInMs` (DB-side expiry — never pass JS Dates for new code), tier table (supporter: warn/timeout/untimeout; moderator: ban/kick/etc.).
  - Known bugs section: remove every item fixed by Tasks 1–15; keep the remaining mediums (config caching, welcome-card member fetch, MODLOG env fallback cross-guild, invite race, lockdown/threads, /timeout cache lookup, announcement modal timing, audit-executor attribution).
- [ ] **Step 2: Full test run** — `npm test` → all suites green.
- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md after audit bugfix round"
```

- [ ] **Step 4: Merge decision** — hand off per superpowers:finishing-a-development-branch (merge into `main` triggers the CI deploy workflow; CI runs the smoke tests against a fresh MySQL 8.4, which independently validates Tasks 11 & 15).

---

## Deferred (explicitly OUT of this plan — next round)

Medium findings not covered here, for a follow-up plan: per-guild config caching; background retry backoff/dead-lettering; welcome-card full-member-fetch; `MODLOG_CHANNEL_ID` cross-guild fallback; escalation exact-threshold-match logic; report cooldown scoping; `/timeout` cache→fetch; `/unmute` hierarchy check; lockdown thread coverage; `/unlock` overwrite restore; announcement modal deferral; audit-log executor attribution; invite-tracking races; obfuscation false positives; muted-role overwrites for new channels; `/setup` wiping extra role tiers.
