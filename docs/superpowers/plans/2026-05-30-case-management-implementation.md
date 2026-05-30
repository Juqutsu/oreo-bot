# Case-Management (Stage 1.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drei neue Slash-Befehle (`/removewarn`, `/modhistory`, `/reason`) plus erweiterte Schema-Migration für Audit-Trail-Cases (`warn_removed`, `reason_edited`) und parent_case_number-Verbindung.

**Architecture:** Additive Schema-Erweiterung via idempotente ALTER-Statements in `server/schema.sql`. Drei neue Repository-Funktionen in `src/cases.js` (`listUserInfractions`, `removeWarn`, `editReason`). Drei neue Befehls-Files mit demselben Pattern wie Stage 1 (`/warn`-Style guards + Mod-Log-Embed). Eine kleine Erweiterung von `case.js` für die neuen Meta-Case-Typen.

**Tech Stack:** Node.js (CommonJS), discord.js v14.26, mysql2/promise, MySQL 8.x.

**Spec:** [docs/superpowers/specs/2026-05-30-case-management-design.md](../specs/2026-05-30-case-management-design.md)

**Branch:** `feat/warn-cases-stage1` (gleicher Branch wie Stage 1, ein PR ships beide).

**Testing-Hinweis:** Keine Test-Suite (per Spec). Manuelle Verifikation in Task 8 + Smoke-Tests pro Repository-Task gegen Docker MySQL.

---

## File Structure

**Zu editieren:**
- `server/schema.sql` — Append "ALTER STATEMENTS"-Block am Ende
- `src/cases.js` — 3 neue Funktionen hinzufügen, module.exports erweitern
- `src/commands/case.js` — TYPE_LABELS/COLORS erweitern, parent_case_number Display

**Zu erstellen:**
- `src/commands/removewarn.js`
- `src/commands/modhistory.js`
- `src/commands/reason.js`

---

## Task 1: Schema-Migration (ALTER STATEMENTS)

**Files:**
- Modify: `server/schema.sql` (append at end)

- [ ] **Step 1: ALTER-Block ans Ende von schema.sql anhängen**

Verwende Edit-Tool, finde diese letzte CREATE TABLE statement:

old_string:
```sql
CREATE TABLE IF NOT EXISTS automod_exemptions (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  guild_id     BIGINT UNSIGNED NOT NULL,
  target_type  ENUM('user','role','channel') NOT NULL,
  target_id    BIGINT UNSIGNED NOT NULL,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  UNIQUE KEY uq_exemption (guild_id, target_type, target_id)
);
```

new_string:
```sql
CREATE TABLE IF NOT EXISTS automod_exemptions (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  guild_id     BIGINT UNSIGNED NOT NULL,
  target_type  ENUM('user','role','channel') NOT NULL,
  target_id    BIGINT UNSIGNED NOT NULL,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  UNIQUE KEY uq_exemption (guild_id, target_type, target_id)
);

-- =========================================================
-- ALTER STATEMENTS (Stage 1.5 — case-management)
-- Run after CREATE TABLE. All idempotent.
-- =========================================================

-- Neue ENUM-Werte für Meta-Cases. MODIFY COLUMN ist idempotent —
-- MySQL setzt die Spalten-Definition auf den Soll-Zustand.
ALTER TABLE infractions MODIFY COLUMN type
  ENUM('warn','timeout','kick','ban','unban','untimeout','warn_removed','reason_edited') NOT NULL;

-- parent_case_number: Verbindung von Meta-Cases zum Original-Case.
-- IF NOT EXISTS ab MySQL 8.0.29 (April 2022).
ALTER TABLE infractions ADD COLUMN IF NOT EXISTS
  parent_case_number INT UNSIGNED NULL AFTER case_number;
```

- [ ] **Step 2: Falls Docker verfügbar — Schema-Loader laufen lassen**

```bash
node --env-file=.env -e "require('./src/schema').ensureSchema().then(() => { console.log('OK'); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); })"
```

Expected: `OK`. Wenn `Unknown column option 'IF NOT EXISTS'` o.ä. → MySQL ist älter als 8.0.29, dann muss IF NOT EXISTS raus und stattdessen ein Pre-Check in schema.js — flag das als BLOCKED.

- [ ] **Step 3: Schema-Änderung verifizieren**

```bash
docker compose exec -T mysql sh -c 'mysql -uoreo -p"$MYSQL_PASSWORD" -e "USE oreo; DESCRIBE infractions;" '
```

Expected: 
- `type` zeigt 8 ENUM-Werte inkl. `warn_removed`, `reason_edited`
- `parent_case_number` Spalte existiert, `INT UNSIGNED`, `YES` für NULL

- [ ] **Step 4: Zweiter Aufruf — Idempotenz prüfen**

```bash
node --env-file=.env -e "require('./src/schema').ensureSchema().then(() => { console.log('OK'); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); })"
```

Expected: `OK` (kein Fehler über existing column oder duplicate ENUM values).

- [ ] **Step 5: Commit**

```bash
git add server/schema.sql
git commit -m "feat(db): add ALTER statements for warn_removed/reason_edited + parent_case_number

Extends infractions.type ENUM and adds parent_case_number column to support
Stage 1.5 case-management (audit-trail meta-cases).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: cases.js — listUserInfractions

**Files:**
- Modify: `src/cases.js`

- [ ] **Step 1: listUserInfractions Funktion hinzufügen**

Verwende Edit-Tool. Füge VOR der module.exports-Zeile ein:

old_string:
```js
module.exports = {
  createCase,
  getCaseByNumber,
  listWarnings,
  countActiveWarnings,
  deactivate,
};
```

new_string:
```js
/**
 * Listet ALLE Infractions eines Users (alle Typen außer Meta-Cases).
 * Für /modhistory.
 * @returns {Promise<object[]>}
 */
async function listUserInfractions(guildId, userId, { includeInactive = true, limit = 25 } = {}) {
  const activeFilter = includeInactive ? '' : 'AND active = 1';
  const [rows] = await getPool().query(
    `SELECT * FROM infractions
       WHERE guild_id = ? AND user_id = ?
         AND type NOT IN ('warn_removed', 'reason_edited')
         ${activeFilter}
       ORDER BY created_at DESC
       LIMIT ${Number(limit)}`,
    [guildId, userId],
  );
  return rows;
}

module.exports = {
  createCase,
  getCaseByNumber,
  listWarnings,
  listUserInfractions,
  countActiveWarnings,
  deactivate,
};
```

- [ ] **Step 2: Syntax-Check**

```bash
node -c src/cases.js
```

Expected: kein Output.

- [ ] **Step 3: Smoke-Test (falls Docker verfügbar)**

Setze ein paar Test-Cases und ruf listUserInfractions auf:

```bash
docker compose exec -T mysql sh -c 'mysql -uoreo -p"$MYSQL_PASSWORD" -e "USE oreo; DELETE FROM infractions; DELETE FROM guilds;"'

node --env-file=.env -e "
const c = require('./src/cases');
(async () => {
  await c.createCase({ guildId: '111', userId: '222', moderatorId: '333', type: 'warn', reason: 'w1' });
  await c.createCase({ guildId: '111', userId: '222', moderatorId: '333', type: 'ban', reason: 'b1' });
  await c.createCase({ guildId: '111', userId: '999', moderatorId: '333', type: 'warn', reason: 'other-user' });
  const all = await c.listUserInfractions('111', '222');
  console.log('count:', all.length, 'types:', all.map(r => r.type).join(','));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
"
```

Expected: `count: 2 types: ban,warn` (newest first).

- [ ] **Step 4: Cleanup**

```bash
docker compose exec -T mysql sh -c 'mysql -uoreo -p"$MYSQL_PASSWORD" -e "USE oreo; DELETE FROM infractions; DELETE FROM guilds;"'
```

- [ ] **Step 5: Commit**

```bash
git add src/cases.js
git commit -m "feat(db): add cases.listUserInfractions for full mod history

Returns all infraction types except meta-cases (warn_removed, reason_edited).
Used by /modhistory to show complete user history.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: cases.js — removeWarn + editReason

**Files:**
- Modify: `src/cases.js`

- [ ] **Step 1: removeWarn Funktion hinzufügen**

Verwende Edit-Tool. Füge VOR der listUserInfractions-Funktion ein:

old_string:
```js
/**
 * Listet ALLE Infractions eines Users (alle Typen außer Meta-Cases).
 * Für /modhistory.
 * @returns {Promise<object[]>}
 */
async function listUserInfractions(guildId, userId, { includeInactive = true, limit = 25 } = {}) {
```

new_string:
```js
/**
 * Soft-Delete einer Warnung. Setzt active=0 + erstellt Meta-Case (type='warn_removed').
 * Transaktional mit SELECT ... FOR UPDATE Lock.
 * @returns {Promise<{metaCaseNumber: number}|null>}
 *   null wenn: Original existiert nicht, ist kein Warn, oder ist bereits active=0
 */
async function removeWarn({ guildId, originalCaseNumber, moderatorId, reason = null }) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();

    // 1. Original laden + lock.
    const [origRows] = await conn.execute(
      'SELECT id, user_id, type, active FROM infractions WHERE guild_id = ? AND case_number = ? FOR UPDATE',
      [guildId, originalCaseNumber],
    );
    const original = origRows[0];
    if (!original || original.type !== 'warn' || !original.active) {
      await conn.rollback();
      return null;
    }

    // 2. Original deaktivieren.
    await conn.execute('UPDATE infractions SET active = 0 WHERE id = ?', [original.id]);

    // 3. Counter inkrementieren.
    await conn.execute(
      'UPDATE guilds SET next_case_number = LAST_INSERT_ID(next_case_number + 1) WHERE guild_id = ?',
      [guildId],
    );
    const [[row]] = await conn.query('SELECT LAST_INSERT_ID() AS metaCaseNumber');
    const metaCaseNumber = row.metaCaseNumber;

    // 4. Meta-Case einfügen.
    await conn.execute(
      `INSERT INTO infractions (guild_id, case_number, parent_case_number, user_id, moderator_id, type, source, reason)
       VALUES (?, ?, ?, ?, ?, 'warn_removed', 'manual', ?)`,
      [guildId, metaCaseNumber, originalCaseNumber, original.user_id, moderatorId, reason],
    );

    await conn.commit();
    return { metaCaseNumber };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Editiert den Reason eines bestehenden Cases. Überschreibt + erstellt Meta-Case (type='reason_edited').
 * Repository-Funktion ist typ-agnostisch — Meta-Case-Schutz liegt im /reason-Command.
 * @returns {Promise<{metaCaseNumber: number, oldReason: string|null}|null>}
 *   null wenn Original-Case nicht existiert
 */
async function editReason({ guildId, originalCaseNumber, moderatorId, newReason }) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();

    const [origRows] = await conn.execute(
      'SELECT id, user_id, reason FROM infractions WHERE guild_id = ? AND case_number = ? FOR UPDATE',
      [guildId, originalCaseNumber],
    );
    const original = origRows[0];
    if (!original) {
      await conn.rollback();
      return null;
    }
    const oldReason = original.reason;

    // 1. Reason überschreiben.
    await conn.execute('UPDATE infractions SET reason = ? WHERE id = ?', [newReason, original.id]);

    // 2. Counter + Meta-Case.
    await conn.execute(
      'UPDATE guilds SET next_case_number = LAST_INSERT_ID(next_case_number + 1) WHERE guild_id = ?',
      [guildId],
    );
    const [[row]] = await conn.query('SELECT LAST_INSERT_ID() AS metaCaseNumber');
    const metaCaseNumber = row.metaCaseNumber;

    // 3. Meta-Case mit Diff im Reason-Feld.
    const diffReason = `Alt: ${oldReason ?? '(leer)'} → Neu: ${newReason ?? '(leer)'}`;
    await conn.execute(
      `INSERT INTO infractions (guild_id, case_number, parent_case_number, user_id, moderator_id, type, source, reason)
       VALUES (?, ?, ?, ?, ?, 'reason_edited', 'manual', ?)`,
      [guildId, metaCaseNumber, originalCaseNumber, original.user_id, moderatorId, diffReason],
    );

    await conn.commit();
    return { metaCaseNumber, oldReason };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Listet ALLE Infractions eines Users (alle Typen außer Meta-Cases).
 * Für /modhistory.
 * @returns {Promise<object[]>}
 */
async function listUserInfractions(guildId, userId, { includeInactive = true, limit = 25 } = {}) {
```

- [ ] **Step 2: module.exports erweitern**

old_string:
```js
module.exports = {
  createCase,
  getCaseByNumber,
  listWarnings,
  listUserInfractions,
  countActiveWarnings,
  deactivate,
};
```

new_string:
```js
module.exports = {
  createCase,
  getCaseByNumber,
  listWarnings,
  listUserInfractions,
  countActiveWarnings,
  deactivate,
  removeWarn,
  editReason,
};
```

- [ ] **Step 3: Syntax-Check**

```bash
node -c src/cases.js
```

- [ ] **Step 4: Smoke-Test (Docker)**

```bash
docker compose exec -T mysql sh -c 'mysql -uoreo -p"$MYSQL_PASSWORD" -e "USE oreo; DELETE FROM infractions; DELETE FROM guilds;"'

node --env-file=.env -e "
const c = require('./src/cases');
(async () => {
  // Setup: warn + ban
  const w = await c.createCase({ guildId: '111', userId: '222', moderatorId: '333', type: 'warn', reason: 'spam' });
  const b = await c.createCase({ guildId: '111', userId: '222', moderatorId: '333', type: 'ban', reason: 'severe' });
  console.log('created:', w.caseNumber, b.caseNumber);

  // removeWarn auf Warn
  const r1 = await c.removeWarn({ guildId: '111', originalCaseNumber: w.caseNumber, moderatorId: '333', reason: 'false alarm' });
  console.log('removeWarn(warn):', r1);

  // removeWarn auf Ban → null erwartet (type check)
  const r2 = await c.removeWarn({ guildId: '111', originalCaseNumber: b.caseNumber, moderatorId: '333', reason: 'no' });
  console.log('removeWarn(ban):', r2);

  // removeWarn auf bereits entfernten Warn → null erwartet
  const r3 = await c.removeWarn({ guildId: '111', originalCaseNumber: w.caseNumber, moderatorId: '333', reason: 'again' });
  console.log('removeWarn(removed):', r3);

  // editReason
  const e1 = await c.editReason({ guildId: '111', originalCaseNumber: b.caseNumber, moderatorId: '333', newReason: 'severe-corrected' });
  console.log('editReason:', e1);

  // editReason auf nicht-existent
  const e2 = await c.editReason({ guildId: '111', originalCaseNumber: 9999, moderatorId: '333', newReason: 'x' });
  console.log('editReason(404):', e2);

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
"
```

Expected:
```
created: 1 2
removeWarn(warn): { metaCaseNumber: 3 }
removeWarn(ban): null
removeWarn(removed): null
editReason: { metaCaseNumber: 4, oldReason: 'severe' }
editReason(404): null
```

- [ ] **Step 5: Cleanup**

```bash
docker compose exec -T mysql sh -c 'mysql -uoreo -p"$MYSQL_PASSWORD" -e "USE oreo; DELETE FROM infractions; DELETE FROM guilds;"'
```

- [ ] **Step 6: Commit**

```bash
git add src/cases.js
git commit -m "feat(db): add cases.removeWarn and cases.editReason with audit meta-cases

Both functions are transactional with FOR UPDATE locks. Soft-delete + meta-case
pattern ensures full audit trail without hard-deletes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: case.js — TYPE_LABELS/COLORS + parent_case_number Display

**Files:**
- Modify: `src/commands/case.js`

- [ ] **Step 1: TYPE_LABELS erweitern**

old_string:
```js
const TYPE_LABELS = {
  warn: '⚠️ Verwarnung',
  timeout: '🔇 Timeout',
  untimeout: '🔊 Timeout aufgehoben',
  kick: '👢 Kick',
  ban: '🔨 Ban',
  unban: '🔓 Unban',
};
```

new_string:
```js
const TYPE_LABELS = {
  warn: '⚠️ Verwarnung',
  timeout: '🔇 Timeout',
  untimeout: '🔊 Timeout aufgehoben',
  kick: '👢 Kick',
  ban: '🔨 Ban',
  unban: '🔓 Unban',
  warn_removed: '✅ Verwarnung entfernt',
  reason_edited: '📝 Grund editiert',
};
```

- [ ] **Step 2: TYPE_COLORS erweitern**

old_string:
```js
const TYPE_COLORS = {
  warn: 0xfaa61a,
  timeout: 0xfaa61a,
  untimeout: 0x57f287,
  kick: 0xed4245,
  ban: 0xed4245,
  unban: 0x57f287,
};
```

new_string:
```js
const TYPE_COLORS = {
  warn: 0xfaa61a,
  timeout: 0xfaa61a,
  untimeout: 0x57f287,
  kick: 0xed4245,
  ban: 0xed4245,
  unban: 0x57f287,
  warn_removed: 0x57f287,
  reason_edited: 0x5865f2,
};
```

- [ ] **Step 3: parent_case_number Embed-Feld einfügen**

In `src/commands/case.js`, finde die Stelle wo die User/Moderator-Felder hinzugefügt werden und ergänze ein parent-Feld direkt davor.

old_string:
```js
    const embed = new EmbedBuilder()
      .setTitle(`${label} — Case #${c.case_number}`)
      .setColor(color)
      .addFields(
        { name: '👤 User', value: `<@${c.user_id}>`, inline: true },
        { name: '🛡️ Moderator', value: `<@${c.moderator_id}>`, inline: true },
        { name: '📅 Erstellt', value: `<t:${createdSec}:f>`, inline: false },
        { name: '📝 Grund', value: reason, inline: false },
      );
```

new_string:
```js
    const embed = new EmbedBuilder()
      .setTitle(`${label} — Case #${c.case_number}`)
      .setColor(color)
      .addFields(
        { name: '👤 User', value: `<@${c.user_id}>`, inline: true },
        { name: '🛡️ Moderator', value: `<@${c.moderator_id}>`, inline: true },
        { name: '📅 Erstellt', value: `<t:${createdSec}:f>`, inline: false },
        { name: '📝 Grund', value: reason, inline: false },
      );

    if (c.parent_case_number) {
      embed.addFields({ name: '🔗 Bezogen auf', value: `Case #${c.parent_case_number}`, inline: true });
    }
```

- [ ] **Step 4: Syntax-Check**

```bash
node -c src/commands/case.js
```

- [ ] **Step 5: Commit**

```bash
git add src/commands/case.js
git commit -m "feat(commands): show meta-case types and parent_case_number link in /case

Adds labels/colors for warn_removed and reason_edited types. When a case has
a parent_case_number, surfaces the link in the embed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: /removewarn Befehl

**Files:**
- Create: `src/commands/removewarn.js`

- [ ] **Step 1: removewarn.js anlegen**

Erstelle `src/commands/removewarn.js` mit:

```js
const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const cases = require('../cases');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('removewarn')
    .setDescription('Entfernt eine Verwarnung (Soft-Delete + Audit-Case).')
    .addIntegerOption((option) => option.setName('case_number').setDescription('Case-Nummer der Verwarnung').setRequired(true).setMinValue(1))
    .addStringOption((option) => option.setName('reason').setDescription('Grund für die Entfernung').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    const originalCaseNumber = interaction.options.getInteger('case_number');
    const reasonInput = interaction.options.getString('reason');
    const reasonForDisplay = reasonInput ?? 'Kein Grund angegeben';
    const moderator = interaction.member;

    // 1. Original-Case prüfen (für klare Fehlermeldungen).
    let original;
    try {
      original = await cases.getCaseByNumber(interaction.guildId, originalCaseNumber);
    } catch (err) {
      console.error('getCaseByNumber failed:', err);
      return interaction.reply({
        content: 'Datenbankfehler — versuch es später nochmal.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!original) {
      return interaction.reply({
        content: `Case #${originalCaseNumber} nicht gefunden.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (original.type !== 'warn') {
      return interaction.reply({
        content: `Case #${originalCaseNumber} ist kein Warn (Type: ${original.type}).`,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!original.active) {
      return interaction.reply({
        content: `Case #${originalCaseNumber} ist bereits entfernt.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // 2. Soft-Delete + Meta-Case.
    let metaCaseNumber;
    try {
      const result = await cases.removeWarn({
        guildId: interaction.guildId,
        originalCaseNumber,
        moderatorId: moderator.id,
        reason: reasonInput,
      });
      if (!result) {
        return interaction.reply({
          content: `Case #${originalCaseNumber} konnte nicht entfernt werden (Race-Condition?).`,
          flags: MessageFlags.Ephemeral,
        });
      }
      metaCaseNumber = result.metaCaseNumber;
    } catch (err) {
      console.error('removeWarn failed:', err);
      return interaction.reply({
        content: 'Datenbankfehler — versuch es später nochmal.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 3. DM an Target (Best-Effort).
    let dmFailed = false;
    try {
      const target = await interaction.client.users.fetch(original.user_id);
      const dmEmbed = new EmbedBuilder()
        .setTitle(`✅ Verwarnung aufgehoben auf ${interaction.guild.name}`)
        .setColor(0x57f287)
        .addFields(
          { name: '🆔 Original-Case', value: `#${originalCaseNumber}`, inline: true },
          { name: '🛡️ Aufgehoben von', value: `<@${moderator.id}>`, inline: true },
          { name: '📝 Grund', value: reasonForDisplay, inline: false },
        )
        .setFooter({ text: '🐾 Oreo' })
        .setTimestamp();
      await target.send({ embeds: [dmEmbed] });
    } catch (err) {
      dmFailed = true;
    }

    // 4. Mod-Reply.
    await interaction.reply({
      content: `Verwarnung Case #${originalCaseNumber} entfernt (Audit Case #${metaCaseNumber}).`,
      flags: MessageFlags.Ephemeral,
    });

    // 5. Mod-Log-Embed (Best-Effort).
    try {
      const logChannel = await interaction.client.channels.fetch(process.env.MODLOG_CHANNEL_ID);
      const modEmbed = new EmbedBuilder()
        .setTitle('✅ Verwarnung entfernt')
        .setColor(0x57f287)
        .addFields(
          { name: '👤 User', value: `<@${original.user_id}>`, inline: false },
          { name: '🛡️ Moderator', value: `<@${moderator.id}>`, inline: false },
          { name: '🔗 Original-Case', value: `#${originalCaseNumber}`, inline: true },
          { name: '📝 Grund', value: reasonForDisplay, inline: false },
        );
      if (dmFailed) {
        modEmbed.addFields({ name: '📬 DM', value: 'Nicht zugestellt (DMs aus?)', inline: false });
      }
      modEmbed.setFooter({ text: `Case #${metaCaseNumber} · 🐾` }).setTimestamp();
      await logChannel.send({ embeds: [modEmbed] });
    } catch (err) {
      console.warn('ModLog send failed:', err);
      await interaction.followUp({
        content: 'Mod-Log-Eintrag fehlgeschlagen. Bitte `MODLOG_CHANNEL_ID` prüfen.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
```

- [ ] **Step 2: Syntax-Check**

```bash
node -c src/commands/removewarn.js
```

- [ ] **Step 3: Commit**

```bash
git add src/commands/removewarn.js
git commit -m "feat(commands): add /removewarn with soft-delete + audit meta-case

Validates case exists, is type=warn, and is active. Soft-deletes via
cases.removeWarn (transactional with FOR UPDATE lock). DMs target,
posts mod-log embed with link to original case.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: /modhistory Befehl

**Files:**
- Create: `src/commands/modhistory.js`

- [ ] **Step 1: modhistory.js anlegen**

Erstelle `src/commands/modhistory.js` mit:

```js
const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const cases = require('../cases');

const TYPE_ICONS = {
  warn: '⚠️',
  timeout: '🔇',
  untimeout: '🔊',
  kick: '👢',
  ban: '🔨',
  unban: '🔓',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('modhistory')
    .setDescription('Zeigt die komplette Mod-Historie eines Users.')
    .addUserOption((option) => option.setName('user').setDescription('Wessen Historie?').setRequired(true))
    .addBooleanOption((option) => option.setName('include_inactive').setDescription('Auch entfernte/aufgehobene Aktionen zeigen (Default: ja)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    const target = interaction.options.getUser('user');
    const includeInactive = interaction.options.getBoolean('include_inactive') ?? true;

    let infractions;
    try {
      infractions = await cases.listUserInfractions(interaction.guildId, target.id, { includeInactive, limit: 25 });
    } catch (err) {
      console.error('listUserInfractions failed:', err);
      return interaction.reply({
        content: 'Datenbankfehler — versuch es später nochmal.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (infractions.length === 0) {
      return interaction.reply({
        content: `**${target.username}** hat keine Mod-Historie.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(`🛡️ Mod-Historie von ${target.username}`)
      .setColor(0x5865f2)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .setFooter({ text: `Insgesamt angezeigt: ${infractions.length} · 🐾` })
      .setTimestamp();

    for (const inf of infractions) {
      const icon = TYPE_ICONS[inf.type] ?? '•';
      const date = new Date(inf.created_at);
      const dateStr = `<t:${Math.floor(date.getTime() / 1000)}:f>`;
      const reason = inf.reason ?? 'Kein Grund angegeben';
      const inactiveBadge = inf.active ? '' : ' [ENTFERNT]';
      embed.addFields({
        name: `${icon} Case #${inf.case_number}${inactiveBadge}`,
        value: `${dateStr}\nvon <@${inf.moderator_id}>\n${reason}`,
        inline: false,
      });
    }

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
```

- [ ] **Step 2: Syntax-Check**

```bash
node -c src/commands/modhistory.js
```

- [ ] **Step 3: Commit**

```bash
git add src/commands/modhistory.js
git commit -m "feat(commands): add /modhistory to show full mod history of a user

Lists all action types (warn/ban/kick/timeout/...) with type-icons. Default
shows active + inactive (so removed warns are visible with [ENTFERNT] badge).
Meta-cases (warn_removed, reason_edited) are filtered out — visible via /case.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: /reason Befehl

**Files:**
- Create: `src/commands/reason.js`

- [ ] **Step 1: reason.js anlegen**

Erstelle `src/commands/reason.js` mit:

```js
const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const cases = require('../cases');

const META_TYPES = new Set(['warn_removed', 'reason_edited']);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('reason')
    .setDescription('Editiert den Grund eines bestehenden Cases.')
    .addIntegerOption((option) => option.setName('case_number').setDescription('Case-Nummer').setRequired(true).setMinValue(1))
    .addStringOption((option) => option.setName('new_reason').setDescription('Neuer Grund').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    const originalCaseNumber = interaction.options.getInteger('case_number');
    const newReason = interaction.options.getString('new_reason');
    const moderator = interaction.member;

    // 1. Original-Case prüfen.
    let original;
    try {
      original = await cases.getCaseByNumber(interaction.guildId, originalCaseNumber);
    } catch (err) {
      console.error('getCaseByNumber failed:', err);
      return interaction.reply({
        content: 'Datenbankfehler — versuch es später nochmal.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!original) {
      return interaction.reply({
        content: `Case #${originalCaseNumber} nicht gefunden.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (META_TYPES.has(original.type)) {
      return interaction.reply({
        content: 'Audit-Cases (warn_removed/reason_edited) können nicht editiert werden.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (original.reason === newReason) {
      return interaction.reply({
        content: 'Neuer Grund ist identisch zum bestehenden — Abbruch.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 2. Reason editieren.
    let metaCaseNumber;
    let oldReason;
    try {
      const result = await cases.editReason({
        guildId: interaction.guildId,
        originalCaseNumber,
        moderatorId: moderator.id,
        newReason,
      });
      if (!result) {
        return interaction.reply({
          content: `Case #${originalCaseNumber} konnte nicht editiert werden.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      metaCaseNumber = result.metaCaseNumber;
      oldReason = result.oldReason;
    } catch (err) {
      console.error('editReason failed:', err);
      return interaction.reply({
        content: 'Datenbankfehler — versuch es später nochmal.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 3. Mod-Reply (kein DM — Mod-interne Korrektur).
    await interaction.reply({
      content: `Grund für Case #${originalCaseNumber} aktualisiert (Audit Case #${metaCaseNumber}).`,
      flags: MessageFlags.Ephemeral,
    });

    // 4. Mod-Log-Embed.
    try {
      const logChannel = await interaction.client.channels.fetch(process.env.MODLOG_CHANNEL_ID);
      const modEmbed = new EmbedBuilder()
        .setTitle('📝 Grund editiert')
        .setColor(0x5865f2)
        .addFields(
          { name: '👤 User', value: `<@${original.user_id}>`, inline: false },
          { name: '🛡️ Moderator', value: `<@${moderator.id}>`, inline: false },
          { name: '🔗 Original-Case', value: `#${originalCaseNumber}`, inline: true },
          { name: '📝 Alt', value: oldReason ?? '(leer)', inline: false },
          { name: '📝 Neu', value: newReason, inline: false },
        )
        .setFooter({ text: `Case #${metaCaseNumber} · 🐾` })
        .setTimestamp();
      await logChannel.send({ embeds: [modEmbed] });
    } catch (err) {
      console.warn('ModLog send failed:', err);
      await interaction.followUp({
        content: 'Mod-Log-Eintrag fehlgeschlagen. Bitte `MODLOG_CHANNEL_ID` prüfen.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
```

- [ ] **Step 2: Syntax-Check**

```bash
node -c src/commands/reason.js
```

- [ ] **Step 3: Commit**

```bash
git add src/commands/reason.js
git commit -m "feat(commands): add /reason to edit a case's reason post-hoc

Validates case exists, isn't a meta-case, and reason actually differs. Overwrites
via cases.editReason which creates an Alt→Neu meta-case for audit trail. No DM
to target — this is a mod-internal correction.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: End-to-End-Verifikation (User-Test-Checkliste)

**Files:** Keine.

Subagents überspringen Discord-Tests — diese Task ist für den User.

- [ ] **Step 1: Bot frisch starten**

```bash
docker compose up -d --build bot
docker compose logs bot --tail=10
```

Expected: `MySQL reachable.` + `Schema sichergestellt.` + `Logged in as Oreo (11 command(s) loaded)`.

(11 = vorher 8 + die 3 neuen aus Stage 1.5.)

- [ ] **Step 2: Setup-Daten anlegen**

In Discord: `/warn @testuser test1`, `/warn @testuser test2`, `/ban @testban schwer`.

Notiere die Case-Nummern (z.B. #1, #2, #3).

- [ ] **Step 3: Test #1 — /removewarn Erfolgsfall**

`/removewarn 1 falsche verwarnung` → DM bei testuser, ephemeral „Case #1 entfernt (Audit Case #4)", grüner Mod-Log.

- [ ] **Step 4: Test #2 — /warnings filtert entfernten Warn**

`/warnings @testuser` → nur Case #2 (Case #1 fehlt, Aktiv: 1).

- [ ] **Step 5: Test #3 — /warnings include_inactive zeigt entfernten**

`/warnings @testuser include_inactive:true` → Case #1 mit `[ENTFERNT]`, Case #2 normal.

- [ ] **Step 6: Test #4 — /case auf Original nach Removal**

`/case 1` → Type warn, Active Nein, Grund unverändert.

- [ ] **Step 7: Test #5 — /case auf Meta-Case**

`/case 4` → Title `✅ Verwarnung entfernt`, Feld `🔗 Bezogen auf Case #1`.

- [ ] **Step 8: Test #6 — Doppel-Removal**

`/removewarn 1` → „Case #1 ist bereits entfernt."

- [ ] **Step 9: Test #7 — Nicht-existent**

`/removewarn 9999` → „Case #9999 nicht gefunden."

- [ ] **Step 10: Test #8 — Falscher Type**

`/removewarn 3` (der Ban) → „Case #3 ist kein Warn (Type: ban)."

- [ ] **Step 11: Test #9 — /modhistory**

`/modhistory @testuser` → Liste mit `[ENTFERNT] Case #1`, `Case #2`. Mit Icons.
`/modhistory @testban` → `Case #3` (Ban) mit 🔨-Icon.

- [ ] **Step 12: Test #10 — /reason**

`/reason 2 präzisierter grund` → ephemeral „aktualisiert (Audit Case #5)", blauer Mod-Log mit Alt/Neu.

- [ ] **Step 13: Test #11 — /case nach Edit**

`/case 2` → Neuer Grund sichtbar, Active Ja.

- [ ] **Step 14: Test #12 — /case auf reason_edited Meta**

`/case 5` → Title `📝 Grund editiert`, Reason zeigt `Alt: ... → Neu: ...`, `🔗 Bezogen auf Case #2`.

- [ ] **Step 15: Test #13 — Meta-Case nicht editierbar**

`/reason 5 hack` → „Audit-Cases (warn_removed/reason_edited) können nicht editiert werden."

- [ ] **Step 16: Test #14 — Reason unverändert**

`/reason 2 präzisierter grund` (gleicher Wert wie Test #12) → „Neuer Grund ist identisch — Abbruch."

- [ ] **Step 17: Test #15 — Race (optional, mit 2 Mods)**

Zwei Mods gleichzeitig `/removewarn 2` → Einer kriegt Audit-Case, der andere „bereits entfernt".

- [ ] **Step 18: Final Commit (oder nichts wenn nur Tests)**

Wenn Bugs aufgetaucht sind: separater Commit. Sonst nichts.

---

## Self-Review-Notiz

Spec-Coverage:

- ✅ Schema-Migration (ALTER STATEMENTS) — Task 1
- ✅ cases.js listUserInfractions — Task 2
- ✅ cases.js removeWarn + editReason — Task 3
- ✅ case.js TYPE_LABELS/COLORS + parent_case_number Display — Task 4
- ✅ /removewarn Befehl — Task 5
- ✅ /modhistory Befehl — Task 6
- ✅ /reason Befehl — Task 7
- ✅ Manuelle Test-Checkliste — Task 8
- ✅ Race-Test (FOR UPDATE Lock) — Task 8 Step 17
- ✅ DM-Failure Best-Effort — Task 5 Code (dmFailed Flag)
- ✅ Mod-Log Best-Effort — alle Befehle (bestehendes Pattern erhalten)
- ✅ Branch-Strategie — bleibt auf feat/warn-cases-stage1 (im Plan-Header dokumentiert)
