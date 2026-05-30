# Warn-System + Case-ID Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persistente Speicherung aller Mod-Aktionen in MySQL mit per-Server fortlaufenden Case-IDs; neue Befehle `/warn`, `/warnings`, `/case`; bestehende Mod-Befehle (ban/kick/timeout/unban/untimeout) schreiben in `infractions` und ersetzen `Case ID: TODO` durch echte Nummern.

**Architecture:** Repository-Pattern: `src/cases.js` ist die einzige Stelle, die DB-Tabellen berührt. `src/schema.js` lädt `server/schema.sql` beim Bot-Start (idempotent). Forward-kompatibles Schema: alle Stage-2/3/4-Tabellen werden angelegt, aber in Stage 1 nicht aktiv genutzt.

**Tech Stack:** Node.js (CommonJS), discord.js v14.26, mysql2/promise, MySQL 8.x, Docker Compose.

**Spec:** [docs/superpowers/specs/2026-05-30-warn-cases-design.md](../specs/2026-05-30-warn-cases-design.md)

**Testing-Hinweis:** Das Projekt hat keine Test-Suite (per Spec-Entscheidung). Jede Task hat **manuelle Verifikations-Schritte** statt automatisierter Tests. Marker für späteres Test-Framework-Setup: Stage 3 (Auto-Eskalation) oder Stage 4 (Automod).

**Prerequisites für die Verifikations-Befehle:**
- Docker Desktop läuft (`docker compose ps` zeigt Services)
- `.env`-Datei im Repo-Root existiert (siehe `.env.example`)
- Vor dem Ausführen von Bash-Verifikations-Befehlen: `set -a; . .env; set +a` (lädt `.env` in die Shell, damit `$MYSQL_PASSWORD` etc. expandiert)
- Auf Windows-PowerShell: stattdessen `Get-Content .env | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { $env:($Matches[1]) = $Matches[2] } }` — oder die Bash-Variante via WSL/Git-Bash
- Test-Server: ein eigener Discord-Test-Server (in `.env` als `GUILD_ID`), in dem du Mod bist und einen Test-User hast

---

## File Structure

**Neu zu erstellen:**
- `server/schema.sql` — Canonical SQL DDL für alle 7 Tabellen
- `src/schema.js` — `ensureSchema()` liest + executet schema.sql idempotent
- `src/cases.js` — Repository: `createCase`, `getCaseByNumber`, `listWarnings`, `countActiveWarnings`, `deactivate`
- `src/commands/warn.js` — Neuer `/warn` Befehl
- `src/commands/warnings.js` — Neuer `/warnings` Befehl
- `src/commands/case.js` — Neuer `/case` Befehl

**Zu editieren:**
- `index.js` — `ensureSchema()` vor `deployCommands` aufrufen
- `src/commands/ban.js` — `cases.createCase()` + Case-Nummer im Footer
- `src/commands/kick.js` — dito
- `src/commands/timeout.js` — dito (mit `durationMs` + `expiresAt`)
- `src/commands/unban.js` — dito
- `src/commands/untimeout.js` — dito

---

## Task 1: Schema-SQL-Datei anlegen

**Files:**
- Create: `server/schema.sql`

- [ ] **Step 1: Verzeichnis prüfen**

```bash
ls server/
```

Expected: `Home Database Scheme.mwb` vorhanden, kein `schema.sql` bisher.

- [ ] **Step 2: schema.sql mit voller DDL anlegen**

Inhalt für `server/schema.sql`:

```sql
-- Oreo Discord Bot — Schema (Stage 1)
-- Idempotent: alle CREATE TABLE haben IF NOT EXISTS.
-- Spec: docs/superpowers/specs/2026-05-30-warn-cases-design.md

-- Per-Server-Konfiguration + Case-Counter
CREATE TABLE IF NOT EXISTS guilds (
  guild_id              BIGINT UNSIGNED PRIMARY KEY,
  report_channel_id     BIGINT UNSIGNED NULL,
  mod_log_channel_id    BIGINT UNSIGNED NULL,
  automod_enabled       TINYINT(1) NOT NULL DEFAULT 0,
  next_case_number      INT UNSIGNED NOT NULL DEFAULT 0,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- User-Profil pro (guild, user)
CREATE TABLE IF NOT EXISTS guild_users (
  guild_id    BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  username    VARCHAR(32) NULL,
  currency    INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (guild_id, user_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
);

-- Alle Mod-Aktionen (warn, ban, kick, timeout, unban, untimeout)
CREATE TABLE IF NOT EXISTS infractions (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  guild_id      BIGINT UNSIGNED NOT NULL,
  case_number   INT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  moderator_id  BIGINT UNSIGNED NOT NULL,
  type          ENUM('warn','timeout','kick','ban','unban','untimeout') NOT NULL,
  source        ENUM('manual','automod','api') NOT NULL DEFAULT 'manual',
  reason        VARCHAR(512) NULL,
  duration_ms   BIGINT UNSIGNED NULL,
  expires_at    DATETIME NULL,
  active        TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  UNIQUE KEY uq_case_per_guild (guild_id, case_number),
  INDEX idx_user_lookup (guild_id, user_id, type, active),
  INDEX idx_recent (guild_id, created_at DESC)
);

-- Stage 2: User-Reports (Tabelle vorbereitet, in Stage 1 leer)
CREATE TABLE IF NOT EXISTS reports (
  id                 BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  guild_id           BIGINT UNSIGNED NOT NULL,
  reporter_id        BIGINT UNSIGNED NOT NULL,
  reported_user_id   BIGINT UNSIGNED NOT NULL,
  reason             VARCHAR(512) NOT NULL,
  evidence_url       VARCHAR(512) NULL,
  status             ENUM('open','investigating','resolved','dismissed') NOT NULL DEFAULT 'open',
  assigned_mod_id    BIGINT UNSIGNED NULL,
  resolution_note    VARCHAR(512) NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at        DATETIME NULL,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  INDEX idx_open_per_guild (guild_id, status, created_at)
);

-- Stage 3: Eskalations-Regeln (Tabelle vorbereitet, in Stage 1 leer)
CREATE TABLE IF NOT EXISTS escalation_rules (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  guild_id          BIGINT UNSIGNED NOT NULL,
  warn_threshold    INT UNSIGNED NOT NULL,
  action            ENUM('timeout','kick','ban') NOT NULL,
  duration_minutes  INT UNSIGNED NULL,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  UNIQUE KEY uq_threshold_per_guild (guild_id, warn_threshold)
);

-- Stage 3: Custom Bot-Permissions pro Rolle (Tabelle vorbereitet, in Stage 1 leer)
CREATE TABLE IF NOT EXISTS role_permissions (
  guild_id    BIGINT UNSIGNED NOT NULL,
  role_id     BIGINT UNSIGNED NOT NULL,
  permission  ENUM('helper','mod','admin') NOT NULL,
  PRIMARY KEY (guild_id, role_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
);

-- Stage 4: Automod-Ausnahmen (Tabelle vorbereitet, in Stage 1 leer)
CREATE TABLE IF NOT EXISTS automod_exemptions (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  guild_id     BIGINT UNSIGNED NOT NULL,
  target_type  ENUM('user','role','channel') NOT NULL,
  target_id    BIGINT UNSIGNED NOT NULL,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  UNIQUE KEY uq_exemption (guild_id, target_type, target_id)
);
```

- [ ] **Step 3: SQL-Syntax mit MySQL-Container verifizieren**

```bash
docker compose up -d mysql
docker compose exec -T mysql mysql -uoreo -p"$MYSQL_PASSWORD" oreo < server/schema.sql
```

Expected: kein Output (Erfolg) oder klare SQL-Fehlermeldung wenn Syntax falsch ist.

- [ ] **Step 4: Tabellen-Existenz prüfen**

```bash
docker compose exec -T mysql mysql -uoreo -p"$MYSQL_PASSWORD" -e "USE oreo; SHOW TABLES;"
```

Expected:
```
Tables_in_oreo
automod_exemptions
escalation_rules
guild_users
guilds
infractions
reports
role_permissions
```

- [ ] **Step 5: Commit**

```bash
git add server/schema.sql
git commit -m "feat(db): add canonical schema.sql with all stage 1-4 tables"
```

---

## Task 2: Schema-Loader (`src/schema.js`)

**Files:**
- Create: `src/schema.js`

- [ ] **Step 1: schema.js anlegen**

Inhalt für `src/schema.js`:

```js
const fs = require('node:fs');
const path = require('node:path');
const { getPool } = require('./db');

const SCHEMA_FILE = path.join(__dirname, '..', 'server', 'schema.sql');

async function ensureSchema() {
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');

  // Statements am Semikolon-Ende-of-Line trennen.
  // In jedem Statement: -- Kommentarzeilen entfernen, trimmen.
  // Leere Statements verwerfen.
  const statements = sql
    .split(/;\s*$/m)
    .map((stmt) =>
      stmt
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter((stmt) => stmt.length > 0);

  const pool = getPool();
  for (const stmt of statements) {
    await pool.query(stmt);
  }
}

module.exports = { ensureSchema };
```

- [ ] **Step 2: Erste Tabelle löschen, um Idempotenz zu prüfen**

```bash
docker compose exec -T mysql mysql -uoreo -p"$MYSQL_PASSWORD" -e "USE oreo; DROP TABLE IF EXISTS infractions, guild_users, automod_exemptions, escalation_rules, role_permissions, reports, guilds;"
```

Expected: Kein Output.

- [ ] **Step 3: ensureSchema() via Node-REPL ausführen**

```bash
node --env-file=.env -e "require('./src/schema').ensureSchema().then(() => { console.log('OK'); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); })"
```

Expected: `OK` und Exit 0.

- [ ] **Step 4: Tabellen prüfen (sollten alle da sein)**

```bash
docker compose exec -T mysql mysql -uoreo -p"$MYSQL_PASSWORD" -e "USE oreo; SHOW TABLES;"
```

Expected: alle 7 Tabellen vorhanden.

- [ ] **Step 5: Zweiter Aufruf — Idempotenz prüfen**

```bash
node --env-file=.env -e "require('./src/schema').ensureSchema().then(() => { console.log('OK'); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); })"
```

Expected: `OK` (keine "table already exists"-Fehler).

- [ ] **Step 6: Commit**

```bash
git add src/schema.js
git commit -m "feat(db): add ensureSchema loader for idempotent boot-time setup"
```

---

## Task 3: Cases-Repository (`src/cases.js`)

**Files:**
- Create: `src/cases.js`

- [ ] **Step 1: cases.js anlegen**

Inhalt für `src/cases.js`:

```js
const { getPool } = require('./db');

/**
 * Erstellt einen neuen Case (= Eintrag in `infractions`).
 * Vergibt atomar die nächste case_number für den Server.
 *
 * @returns {Promise<{caseNumber: number, infractionId: number}>}
 */
async function createCase({
  guildId,
  userId,
  moderatorId,
  type,
  reason = null,
  durationMs = null,
  expiresAt = null,
  source = 'manual',
}) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();

    // 1. Guild-Row sicherstellen (no-op wenn schon da).
    await conn.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [guildId]);

    // 2. Counter atomar inkrementieren; neuer Wert landet in LAST_INSERT_ID.
    await conn.execute(
      'UPDATE guilds SET next_case_number = LAST_INSERT_ID(next_case_number + 1) WHERE guild_id = ?',
      [guildId],
    );

    // 3. Neuen case_number auslesen.
    const [[row]] = await conn.query('SELECT LAST_INSERT_ID() AS caseNumber');
    const caseNumber = row.caseNumber;

    // 4. Infraction speichern.
    const [result] = await conn.execute(
      `INSERT INTO infractions
         (guild_id, case_number, user_id, moderator_id, type, source, reason, duration_ms, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [guildId, caseNumber, userId, moderatorId, type, source, reason, durationMs, expiresAt],
    );

    await conn.commit();
    return { caseNumber, infractionId: result.insertId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Lädt einen Case anhand seiner Nummer (pro Guild eindeutig).
 * @returns {Promise<object|null>}
 */
async function getCaseByNumber(guildId, caseNumber) {
  const [rows] = await getPool().execute(
    'SELECT * FROM infractions WHERE guild_id = ? AND case_number = ?',
    [guildId, caseNumber],
  );
  return rows[0] ?? null;
}

/**
 * Listet Warnungen eines Users.
 * @returns {Promise<object[]>}
 */
async function listWarnings(guildId, userId, { includeInactive = false, limit = 25 } = {}) {
  const activeFilter = includeInactive ? '' : 'AND active = 1';
  const [rows] = await getPool().execute(
    `SELECT * FROM infractions
       WHERE guild_id = ? AND user_id = ? AND type = 'warn' ${activeFilter}
       ORDER BY created_at DESC
       LIMIT ?`,
    [guildId, userId, limit],
  );
  return rows;
}

/**
 * Zählt aktive Warnungen eines Users.
 * @returns {Promise<number>}
 */
async function countActiveWarnings(guildId, userId) {
  const [[row]] = await getPool().execute(
    `SELECT COUNT(*) AS n FROM infractions
       WHERE guild_id = ? AND user_id = ? AND type = 'warn' AND active = 1`,
    [guildId, userId],
  );
  return Number(row.n);
}

/**
 * Setzt eine Infraction auf inactive (für späteres /removewarn).
 * @returns {Promise<boolean>} true wenn ein Row geändert wurde.
 */
async function deactivate(guildId, caseNumber) {
  const [result] = await getPool().execute(
    'UPDATE infractions SET active = 0 WHERE guild_id = ? AND case_number = ?',
    [guildId, caseNumber],
  );
  return result.affectedRows > 0;
}

module.exports = {
  createCase,
  getCaseByNumber,
  listWarnings,
  countActiveWarnings,
  deactivate,
};
```

- [ ] **Step 2: Tabellen leeren für sauberen Test**

```bash
docker compose exec -T mysql mysql -uoreo -p"$MYSQL_PASSWORD" -e "USE oreo; DELETE FROM infractions; DELETE FROM guilds;"
```

Expected: Kein Output.

- [ ] **Step 3: Smoke-Test: drei Cases auf einem Server erzeugen**

```bash
node --env-file=.env -e "
const c = require('./src/cases');
(async () => {
  const r1 = await c.createCase({ guildId: 111n, userId: 222n, moderatorId: 333n, type: 'warn', reason: 'test 1' });
  const r2 = await c.createCase({ guildId: 111n, userId: 222n, moderatorId: 333n, type: 'ban', reason: 'test 2' });
  const r3 = await c.createCase({ guildId: 999n, userId: 222n, moderatorId: 333n, type: 'warn', reason: 'other server' });
  console.log('r1:', r1, 'r2:', r2, 'r3:', r3);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
"
```

Expected:
```
r1: { caseNumber: 1, infractionId: 1 } r2: { caseNumber: 2, infractionId: 2 } r3: { caseNumber: 1, infractionId: 3 }
```

(Server 999 hat seinen eigenen Counter, der bei 1 startet.)

- [ ] **Step 4: Smoke-Test: Lookup-Funktionen**

```bash
node --env-file=.env -e "
const c = require('./src/cases');
(async () => {
  const case1 = await c.getCaseByNumber(111n, 1);
  const warns = await c.listWarnings(111n, 222n);
  const count = await c.countActiveWarnings(111n, 222n);
  console.log('case#1 type:', case1.type, 'reason:', case1.reason);
  console.log('warns count:', warns.length);
  console.log('active warns:', count);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
"
```

Expected:
```
case#1 type: warn reason: test 1
warns count: 1
active warns: 1
```

- [ ] **Step 5: Test-Daten wieder löschen**

```bash
docker compose exec -T mysql mysql -uoreo -p"$MYSQL_PASSWORD" -e "USE oreo; DELETE FROM infractions; DELETE FROM guilds;"
```

- [ ] **Step 6: Commit**

```bash
git add src/cases.js
git commit -m "feat(db): add cases repository with atomic case-number allocation"
```

---

## Task 4: Schema-Loader in `index.js` einhängen

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Aktuellen Stand der Startup-Sequenz prüfen**

Aktuell (`index.js` Zeilen 56-71):
```js
(async () => {
  try {
    await pingDb();
    console.log('MySQL reachable.');
  } catch (err) {
    console.error('Failed to reach MySQL:', err.message);
    process.exit(1);
  }

  await deployCommands({
    token: DISCORD_TOKEN,
    clientId: CLIENT_ID,
    guildId: GUILD_ID,
    commands: client.commands,
  });
  await client.login(DISCORD_TOKEN);
})();
```

- [ ] **Step 2: Import-Zeile für ensureSchema hinzufügen**

In `index.js` direkt nach Zeile 3 (`const { ping: pingDb } = require('./src/db');`) einfügen:

```js
const { ensureSchema } = require('./src/schema');
```

- [ ] **Step 3: ensureSchema-Aufruf in Startup-Sequenz einbauen**

Den `(async () => { ... })()`-Block in `index.js` (Zeilen 56-71) ersetzen durch:

```js
(async () => {
  try {
    await pingDb();
    console.log('MySQL reachable.');
  } catch (err) {
    console.error('Failed to reach MySQL:', err.message);
    process.exit(1);
  }

  try {
    await ensureSchema();
    console.log('Schema sichergestellt.');
  } catch (err) {
    console.error('Schema-Setup fehlgeschlagen:', err.message);
    process.exit(1);
  }

  await deployCommands({
    token: DISCORD_TOKEN,
    clientId: CLIENT_ID,
    guildId: GUILD_ID,
    commands: client.commands,
  });
  await client.login(DISCORD_TOKEN);
})();
```

- [ ] **Step 4: Bot starten und Startup-Logs prüfen**

```bash
docker compose up --build bot 2>&1 | head -30
```

(Strg+C nach 10 Sekunden — wir wollen nur die Boot-Logs sehen.)

Expected output enthält:
```
MySQL reachable.
Schema sichergestellt.
Logged in as <BotName> (<N> command(s) loaded)
```

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(boot): ensure schema is loaded before deploying commands"
```

---

## Task 5: `/warn` Befehl

**Files:**
- Create: `src/commands/warn.js`

- [ ] **Step 1: warn.js anlegen**

Inhalt für `src/commands/warn.js`:

```js
const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const cases = require('../cases');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Verwarnt einen Nutzer und speichert es als Case.')
    .addUserOption((option) => option.setName('target').setDescription('Wer soll verwarnt werden?').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('Grund für die Verwarnung').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    const target = interaction.options.getUser('target');
    const reasonInput = interaction.options.getString('reason');
    const reasonForDisplay = reasonInput ?? 'Kein Grund angegeben';

    const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
    const moderator = interaction.member;
    const botMember = interaction.guild.members.me;

    if (!targetMember) return interaction.reply({
      content: 'Dieser User ist nicht (mehr) auf dem Server.',
      flags: MessageFlags.Ephemeral,
    });

    if (target.id === moderator.id) return interaction.reply({
      content: 'Selbst-Verwarnung geht nicht.',
      flags: MessageFlags.Ephemeral,
    });

    if (target.id === botMember.id) return interaction.reply({
      content: 'Oreo kann sich nicht selber verwarnen.',
      flags: MessageFlags.Ephemeral,
    });

    if (target.id === interaction.guild.ownerId) return interaction.reply({
      content: 'Den Server-Inhaber kannst du nicht verwarnen.',
      flags: MessageFlags.Ephemeral,
    });

    if (moderator.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) return interaction.reply({
      content: 'Diese Person hat dieselbe oder eine höhere Rolle als du.',
      flags: MessageFlags.Ephemeral,
    });

    // 1. Case in DB schreiben (wenn das failt, brechen wir komplett ab).
    let caseNumber;
    try {
      const result = await cases.createCase({
        guildId: BigInt(interaction.guildId),
        userId: BigInt(target.id),
        moderatorId: BigInt(moderator.id),
        type: 'warn',
        reason: reasonInput,
      });
      caseNumber = result.caseNumber;
    } catch (err) {
      console.error('createCase failed:', err);
      return interaction.reply({
        content: 'Datenbankfehler — versuch es später nochmal.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 2. DM an Target (Best-Effort).
    let dmFailed = false;
    try {
      const dmEmbed = new EmbedBuilder()
        .setTitle(`⚠️ Verwarnung auf ${interaction.guild.name}`)
        .setColor(0xfaa61a)
        .addFields(
          { name: '📝 Grund', value: reasonForDisplay, inline: false },
          { name: '🆔 Case', value: `#${caseNumber}`, inline: true },
        )
        .setFooter({ text: '🐾 Oreo' })
        .setTimestamp();
      await target.send({ embeds: [dmEmbed] });
    } catch (err) {
      dmFailed = true;
    }

    // 3. Mod-Reply.
    await interaction.reply({
      content: `**${target.username}** wurde verwarnt (Case #${caseNumber}).`,
      flags: MessageFlags.Ephemeral,
    });

    // 4. Mod-Log-Embed (Best-Effort).
    try {
      const logChannel = await interaction.client.channels.fetch(process.env.MODLOG_CHANNEL_ID);
      const modEmbed = new EmbedBuilder()
        .setTitle('⚠️ User verwarnt')
        .setColor(0xfaa61a)
        .setThumbnail(target.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: '👤 User', value: `<@${target.id}>`, inline: false },
          { name: '🛡️ Moderator', value: `<@${moderator.id}>`, inline: false },
          { name: '📝 Grund', value: reasonForDisplay, inline: false },
        );
      if (dmFailed) {
        modEmbed.addFields({ name: '📬 DM', value: 'Nicht zugestellt (DMs aus?)', inline: false });
      }
      modEmbed.setFooter({ text: `Case #${caseNumber} · 🐾` }).setTimestamp();
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
node -c src/commands/warn.js
```

Expected: Kein Output (= valide JS-Syntax).

- [ ] **Step 3: Bot neu starten (registriert /warn auto)**

```bash
docker compose up -d --build bot
docker compose logs -f bot --tail=20
```

(Strg+C nach Logs sichtbar.)

Expected output enthält:
```
Schema sichergestellt.
Logged in as <BotName>
```

und der Befehl-Count ist um 1 höher als vorher.

- [ ] **Step 4: Manuell /warn in Discord testen**

In Discord:
1. `/warn @testuser spamming`
2. Verifizieren:
   - DM an Testuser kommt an (gelber Embed mit Case #1)
   - Mod-Log-Embed im MODLOG_CHANNEL erscheint (gelb, Case #1 im Footer)
   - Ephemeral Reply: `testuser wurde verwarnt (Case #1).`

- [ ] **Step 5: DB-Eintrag prüfen**

```bash
docker compose exec -T mysql mysql -uoreo -p"$MYSQL_PASSWORD" -e "USE oreo; SELECT case_number, type, user_id, moderator_id, reason FROM infractions ORDER BY id DESC LIMIT 5;"
```

Expected: Der eben erstellte Warn-Eintrag ist sichtbar.

- [ ] **Step 6: Commit**

```bash
git add src/commands/warn.js
git commit -m "feat(commands): add /warn with DM, mod-log, and persistent case"
```

---

## Task 6: `/warnings` Befehl

**Files:**
- Create: `src/commands/warnings.js`

- [ ] **Step 1: warnings.js anlegen**

Inhalt für `src/commands/warnings.js`:

```js
const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const cases = require('../cases');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('Zeigt die Verwarnungen eines Users.')
    .addUserOption((option) => option.setName('target').setDescription('Wessen Verwarnungen?').setRequired(true))
    .addBooleanOption((option) => option.setName('include_inactive').setDescription('Auch entfernte Verwarnungen zeigen').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    const target = interaction.options.getUser('target');
    const includeInactive = interaction.options.getBoolean('include_inactive') ?? false;

    let warns;
    let activeCount;
    try {
      warns = await cases.listWarnings(BigInt(interaction.guildId), BigInt(target.id), { includeInactive, limit: 25 });
      activeCount = await cases.countActiveWarnings(BigInt(interaction.guildId), BigInt(target.id));
    } catch (err) {
      console.error('listWarnings failed:', err);
      return interaction.reply({
        content: 'Datenbankfehler — versuch es später nochmal.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (warns.length === 0) {
      return interaction.reply({
        content: `**${target.username}** hat keine ${includeInactive ? '' : 'aktiven '}Verwarnungen.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(`⚠️ Verwarnungen von ${target.username}`)
      .setColor(0xfaa61a)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .setFooter({ text: `Aktive: ${activeCount} · Gesamt angezeigt: ${warns.length} · 🐾` })
      .setTimestamp();

    for (const w of warns) {
      const date = new Date(w.created_at);
      const dateStr = `<t:${Math.floor(date.getTime() / 1000)}:f>`;
      const reason = w.reason ?? 'Kein Grund angegeben';
      const activeBadge = w.active ? '' : ' [ENTFERNT]';
      embed.addFields({
        name: `Case #${w.case_number}${activeBadge}`,
        value: `${dateStr}\nvon <@${w.moderator_id}>\n${reason}`,
        inline: false,
      });
    }

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
```

- [ ] **Step 2: Syntax-Check**

```bash
node -c src/commands/warnings.js
```

Expected: Kein Output.

- [ ] **Step 3: Bot neu starten**

```bash
docker compose up -d --build bot
```

- [ ] **Step 4: Manuell /warnings testen**

In Discord:
1. `/warnings @testuser` — sollte den einen Warn aus Task 5 zeigen, Footer "Aktive: 1 · Gesamt angezeigt: 1"
2. `/warn @testuser zweiter Test` (noch eine Verwarnung)
3. `/warnings @testuser` — jetzt 2 Einträge, Footer "Aktive: 2"
4. `/warnings @neutraluser` — `keine aktiven Verwarnungen`

- [ ] **Step 5: Commit**

```bash
git add src/commands/warnings.js
git commit -m "feat(commands): add /warnings to list a user's warns"
```

---

## Task 7: `/case` Befehl

**Files:**
- Create: `src/commands/case.js`

- [ ] **Step 1: case.js anlegen**

Inhalt für `src/commands/case.js`:

```js
const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const cases = require('../cases');

const TYPE_LABELS = {
  warn: '⚠️ Verwarnung',
  timeout: '🔇 Timeout',
  untimeout: '🔊 Timeout aufgehoben',
  kick: '👢 Kick',
  ban: '🔨 Ban',
  unban: '🔓 Unban',
};

const TYPE_COLORS = {
  warn: 0xfaa61a,
  timeout: 0xfaa61a,
  untimeout: 0x57f287,
  kick: 0xed4245,
  ban: 0xed4245,
  unban: 0x57f287,
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('case')
    .setDescription('Zeigt einen Case anhand der Nummer.')
    .addIntegerOption((option) => option.setName('number').setDescription('Case-Nummer').setRequired(true).setMinValue(1))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    const caseNumber = interaction.options.getInteger('number');

    let c;
    try {
      c = await cases.getCaseByNumber(BigInt(interaction.guildId), caseNumber);
    } catch (err) {
      console.error('getCaseByNumber failed:', err);
      return interaction.reply({
        content: 'Datenbankfehler — versuch es später nochmal.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!c) {
      return interaction.reply({
        content: `Case #${caseNumber} nicht gefunden.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const label = TYPE_LABELS[c.type] ?? c.type;
    const color = TYPE_COLORS[c.type] ?? 0x99aab5;
    const createdSec = Math.floor(new Date(c.created_at).getTime() / 1000);
    const reason = c.reason ?? 'Kein Grund angegeben';

    const embed = new EmbedBuilder()
      .setTitle(`${label} — Case #${c.case_number}`)
      .setColor(color)
      .addFields(
        { name: '👤 User', value: `<@${c.user_id}>`, inline: true },
        { name: '🛡️ Moderator', value: `<@${c.moderator_id}>`, inline: true },
        { name: '📅 Erstellt', value: `<t:${createdSec}:f>`, inline: false },
        { name: '📝 Grund', value: reason, inline: false },
      );

    if (c.duration_ms) {
      embed.addFields({ name: '⏱️ Dauer (ms)', value: String(c.duration_ms), inline: true });
    }
    if (c.expires_at) {
      const expSec = Math.floor(new Date(c.expires_at).getTime() / 1000);
      embed.addFields({ name: '📅 Läuft ab', value: `<t:${expSec}:f>`, inline: true });
    }
    embed.addFields(
      { name: '✅ Aktiv', value: c.active ? 'Ja' : 'Nein', inline: true },
      { name: '🔧 Quelle', value: c.source, inline: true },
    );
    embed.setFooter({ text: `🐾 Oreo` }).setTimestamp();

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
```

- [ ] **Step 2: Syntax-Check**

```bash
node -c src/commands/case.js
```

Expected: Kein Output.

- [ ] **Step 3: Bot neu starten**

```bash
docker compose up -d --build bot
```

- [ ] **Step 4: Manuell /case testen**

In Discord:
1. `/case 1` — zeigt den ersten Warn (oder was auch immer Case #1 ist)
2. `/case 9999` — `Case #9999 nicht gefunden.`

- [ ] **Step 5: Commit**

```bash
git add src/commands/case.js
git commit -m "feat(commands): add /case to look up any moderation action by number"
```

---

## Task 8: `/ban` auf Cases umstellen

**Files:**
- Modify: `src/commands/ban.js`

- [ ] **Step 1: Import von cases hinzufügen**

In `src/commands/ban.js` Zeile 1 ersetzen:

```js
const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
```

durch:

```js
const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const cases = require('../cases');
```

- [ ] **Step 2: Nach erfolgreichem `interaction.guild.members.ban(...)` Case anlegen**

Im `try { await interaction.guild.members.ban(...) }`-Block ist die aktuelle Struktur (ca. Zeilen 47-58):

```js
    try {
      await interaction.guild.members.ban(target.id, {
        reason: `${moderator.user.tag}: ${reason}`,
      });
    } catch (e) {
      console.error(e);
      return interaction.reply({
        content: 'Der Ban hat nicht geklappt. Details stehen in den Logs.',
        flags: MessageFlags.Ephemeral,
      });
    }
```

Direkt nach diesem `try/catch`-Block (also vor `await interaction.reply({ content: '**${target.username}** wurde gebannt.' ...})`) hinzufügen:

```js
    let caseNumber;
    try {
      const result = await cases.createCase({
        guildId: BigInt(interaction.guildId),
        userId: BigInt(target.id),
        moderatorId: BigInt(moderator.id),
        type: 'ban',
        reason: interaction.options.getString('reason'),
      });
      caseNumber = result.caseNumber;
    } catch (err) {
      console.error('createCase failed:', err);
      // Ban ist passiert, aber Case-Eintrag failed. Wir markieren das im Footer.
      caseNumber = null;
    }
```

- [ ] **Step 3: Footer im Mod-Log-Embed ersetzen**

Im Mod-Log-Embed (ca. Zeile 75) ist aktuell:

```js
        .setFooter({ text: 'Case ID: TODO · 🐾' })
```

Ersetzen durch:

```js
        .setFooter({ text: caseNumber ? `Case #${caseNumber} · 🐾` : 'Case-Eintrag fehlgeschlagen · 🐾' })
```

- [ ] **Step 4: Syntax-Check**

```bash
node -c src/commands/ban.js
```

Expected: Kein Output.

- [ ] **Step 5: Bot neu starten + manuell /ban testen**

```bash
docker compose up -d --build bot
```

In Discord:
1. `/ban @testuser test ban` — User wird gebannt, Mod-Log-Embed zeigt `Case #N` (N = nächste Nummer)
2. `/case <N>` — zeigt Ban-Details

- [ ] **Step 6: DB prüfen**

```bash
docker compose exec -T mysql mysql -uoreo -p"$MYSQL_PASSWORD" -e "USE oreo; SELECT case_number, type, reason FROM infractions ORDER BY id DESC LIMIT 3;"
```

Expected: Der eben erstellte Ban-Eintrag mit type='ban' ist sichtbar.

- [ ] **Step 7: Commit**

```bash
git add src/commands/ban.js
git commit -m "feat(commands): persist /ban as case with real case number in footer"
```

---

## Task 9: `/unban` auf Cases umstellen

**Files:**
- Modify: `src/commands/unban.js`

- [ ] **Step 1: Import von cases hinzufügen**

In `src/commands/unban.js` Zeile 1 ersetzen durch:

```js
const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const cases = require('../cases');
```

- [ ] **Step 2: Nach erfolgreichem `bans.remove(...)` Case anlegen**

Aktuelle Struktur (ca. Zeilen 49-58):

```js
    try {
      await interaction.guild.bans.remove(targetId, `${moderator.user.tag}: ${reason}`);
    } catch (e) {
      console.error(e);
      return interaction.reply({
        content: 'Die Entbannung hat nicht geklappt. Details stehen in den Logs.',
        flags: MessageFlags.Ephemeral,
      });
    }
```

Direkt nach diesem `try/catch` hinzufügen:

```js
    let caseNumber;
    try {
      const result = await cases.createCase({
        guildId: BigInt(interaction.guildId),
        userId: BigInt(targetId),
        moderatorId: BigInt(moderator.id),
        type: 'unban',
        reason: interaction.options.getString('reason'),
      });
      caseNumber = result.caseNumber;
    } catch (err) {
      console.error('createCase failed:', err);
      caseNumber = null;
    }
```

- [ ] **Step 3: Footer ersetzen**

Aktuell:

```js
        .setFooter({ text: 'Case ID: TODO · 🐾' })
```

Ersetzen durch:

```js
        .setFooter({ text: caseNumber ? `Case #${caseNumber} · 🐾` : 'Case-Eintrag fehlgeschlagen · 🐾' })
```

- [ ] **Step 4: Syntax-Check + Test**

```bash
node -c src/commands/unban.js
docker compose up -d --build bot
```

In Discord: User aus Task 8 mit `/unban` entbannen, Case-Nummer im Mod-Log prüfen.

- [ ] **Step 5: Commit**

```bash
git add src/commands/unban.js
git commit -m "feat(commands): persist /unban as case with real case number"
```

---

## Task 10: `/kick` auf Cases umstellen

**Files:**
- Modify: `src/commands/kick.js`

- [ ] **Step 1: Import von cases hinzufügen**

In `src/commands/kick.js` Zeile 1 ersetzen durch:

```js
const { SlashCommandBuilder, MessageFlags, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const cases = require('../cases');
```

- [ ] **Step 2: Nach erfolgreichem `members.kick(...)` Case anlegen**

Aktuelle Struktur (ca. Zeilen 47-58):

```js
    try {
      await interaction.guild.members.kick(target.id, {
        reason: `${moderator.user.tag}: ${reason}`,
      });
    } catch (e) {
      console.error(e);
      return interaction.reply({
        content: 'Der Kick hat nicht geklappt. Details stehen in den Logs.',
        flags: MessageFlags.Ephemeral,
      });
    }
```

Direkt nach diesem `try/catch` hinzufügen:

```js
    let caseNumber;
    try {
      const result = await cases.createCase({
        guildId: BigInt(interaction.guildId),
        userId: BigInt(target.id),
        moderatorId: BigInt(moderator.id),
        type: 'kick',
        reason: interaction.options.getString('reason'),
      });
      caseNumber = result.caseNumber;
    } catch (err) {
      console.error('createCase failed:', err);
      caseNumber = null;
    }
```

- [ ] **Step 3: Footer ersetzen**

Aktuell:

```js
            .setFooter({ text: 'Case ID: TODO · 🐾' })
```

Ersetzen durch:

```js
            .setFooter({ text: caseNumber ? `Case #${caseNumber} · 🐾` : 'Case-Eintrag fehlgeschlagen · 🐾' })
```

- [ ] **Step 4: Syntax-Check + Test**

```bash
node -c src/commands/kick.js
docker compose up -d --build bot
```

In Discord: `/kick @testuser test kick` — Mod-Log zeigt echte Case-Nummer.

- [ ] **Step 5: Commit**

```bash
git add src/commands/kick.js
git commit -m "feat(commands): persist /kick as case with real case number"
```

---

## Task 11: `/timeout` auf Cases umstellen (mit Duration + Expiry)

**Files:**
- Modify: `src/commands/timeout.js`

- [ ] **Step 1: Import von cases hinzufügen**

In `src/commands/timeout.js` Zeile 1 ersetzen durch:

```js
const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const cases = require('../cases');
```

- [ ] **Step 2: Nach erfolgreichem `targetMember.timeout(...)` Case anlegen**

Aktuelle Struktur (ca. Zeilen 105-114):

```js
    try {
      await targetMember.timeout(durationMs, `${moderator.user.tag}: ${reason}`);
    } catch (e) {
      console.error(e);
      return interaction.reply({
        content: 'Der Timeout hat nicht geklappt. Details stehen in den Logs.',
        flags: MessageFlags.Ephemeral,
      });
    }
```

Direkt nach diesem `try/catch` (und vor `const durationLabel = formatDuration(durationMs);`) hinzufügen:

```js
    const expiresAtDate = new Date(Date.now() + durationMs);
    let caseNumber;
    try {
      const result = await cases.createCase({
        guildId: BigInt(interaction.guildId),
        userId: BigInt(target.id),
        moderatorId: BigInt(moderator.id),
        type: 'timeout',
        reason: interaction.options.getString('reason'),
        durationMs: BigInt(durationMs),
        expiresAt: expiresAtDate,
      });
      caseNumber = result.caseNumber;
    } catch (err) {
      console.error('createCase failed:', err);
      caseNumber = null;
    }
```

- [ ] **Step 3: Footer ersetzen**

Aktuell:

```js
        .setFooter({ text: 'Case ID: TODO · 🐾' })
```

Ersetzen durch:

```js
        .setFooter({ text: caseNumber ? `Case #${caseNumber} · 🐾` : 'Case-Eintrag fehlgeschlagen · 🐾' })
```

- [ ] **Step 4: Syntax-Check + Test**

```bash
node -c src/commands/timeout.js
docker compose up -d --build bot
```

In Discord: `/timeout @testuser 5m test` — Mod-Log zeigt Case-Nummer + Dauer + Läuft-ab.

- [ ] **Step 5: DB prüfen — duration_ms und expires_at korrekt?**

```bash
docker compose exec -T mysql mysql -uoreo -p"$MYSQL_PASSWORD" -e "USE oreo; SELECT case_number, type, duration_ms, expires_at FROM infractions WHERE type='timeout' ORDER BY id DESC LIMIT 1;"
```

Expected: `duration_ms = 300000` (5 Minuten), `expires_at` ca. 5 Min nach jetzt.

- [ ] **Step 6: Commit**

```bash
git add src/commands/timeout.js
git commit -m "feat(commands): persist /timeout as case with duration and expiry"
```

---

## Task 12: `/untimeout` auf Cases umstellen

**Files:**
- Modify: `src/commands/untimeout.js`

- [ ] **Step 1: Import von cases hinzufügen**

In `src/commands/untimeout.js` Zeile 1 ersetzen durch:

```js
const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const cases = require('../cases');
```

- [ ] **Step 2: Nach erfolgreichem `targetMember.timeout(null, ...)` Case anlegen**

Aktuelle Struktur (ca. Zeilen 41-49):

```js
    try {
      await targetMember.timeout(null, `${moderator.user.tag}: ${reason}`);
    } catch (e) {
      console.error(e);
      return interaction.reply({
        content: 'Das Aufheben hat nicht geklappt. Details stehen in den Logs.',
        flags: MessageFlags.Ephemeral,
      });
    }
```

Direkt nach diesem `try/catch` hinzufügen:

```js
    let caseNumber;
    try {
      const result = await cases.createCase({
        guildId: BigInt(interaction.guildId),
        userId: BigInt(target.id),
        moderatorId: BigInt(moderator.id),
        type: 'untimeout',
        reason: interaction.options.getString('reason'),
      });
      caseNumber = result.caseNumber;
    } catch (err) {
      console.error('createCase failed:', err);
      caseNumber = null;
    }
```

- [ ] **Step 3: Footer ersetzen**

Aktuell:

```js
        .setFooter({ text: 'Case ID: TODO · 🐾' })
```

Ersetzen durch:

```js
        .setFooter({ text: caseNumber ? `Case #${caseNumber} · 🐾` : 'Case-Eintrag fehlgeschlagen · 🐾' })
```

- [ ] **Step 4: Syntax-Check + Test**

```bash
node -c src/commands/untimeout.js
docker compose up -d --build bot
```

In Discord: User aus Task 11 mit `/untimeout` aus Timeout holen — Mod-Log zeigt Case-Nummer.

- [ ] **Step 5: Commit**

```bash
git add src/commands/untimeout.js
git commit -m "feat(commands): persist /untimeout as case with real case number"
```

---

## Task 13: End-to-End-Verifikation (Test-Checkliste aus Spec)

**Files:** Keine.

Das ist der manuelle Smoke-Test-Durchlauf gegen die Spec-Test-Liste.

- [ ] **Step 1: DB leeren für sauberen Start**

```bash
docker compose exec -T mysql mysql -uoreo -p"$MYSQL_PASSWORD" -e "USE oreo; DELETE FROM infractions; DELETE FROM guilds;"
```

- [ ] **Step 2: Bot frisch starten**

```bash
docker compose up -d --build bot
docker compose logs bot --tail=10
```

Expected: `MySQL reachable.` und `Schema sichergestellt.` und `Logged in as ...`.

- [ ] **Step 3: Test #1 — Erstes Warn**

In Discord: `/warn @testuser test 1`

Verify:
- DM bei Testuser angekommen
- Mod-Log Embed mit `Case #1`
- Ephemeral Reply: `testuser wurde verwarnt (Case #1).`

- [ ] **Step 4: Test #2 — Zweites Warn**

`/warn @testuser2 test 2` → Erwartung: Mod-Log zeigt `Case #2`.

- [ ] **Step 5: Test #3 — Owner schützen**

`/warn @<Server-Owner> ...` → Erwartung: `Den Server-Inhaber kannst du nicht verwarnen.`

- [ ] **Step 6: Test #4 — DM-Failure**

Testuser stellt DMs für den Server aus, dann `/warn @testuser test 3`.
Erwartung: Reply ok, Mod-Log enthält Feld `📬 DM: Nicht zugestellt (DMs aus?)`.

- [ ] **Step 7: Test #5 — /warnings**

`/warnings @testuser` → Erwartung: Embed mit 2 Feldern (Case #1, Case #3 — Case #2 war anderer User), Footer `Aktive: 2 · Gesamt angezeigt: 2`.

- [ ] **Step 8: Test #6 — /case 1**

`/case 1` → Erwartung: vollständiger Embed.

- [ ] **Step 9: Test #7 — /case 9999**

`/case 9999` → Erwartung: `Case #9999 nicht gefunden.`

- [ ] **Step 10: Test #8 — /ban + /case**

`/ban @testban test ban` → notiere Case-Nummer N.
`/case <N>` → Erwartung: Ban-Details mit roter Farbe und 🔨-Icon.

- [ ] **Step 11: Test #9 — DB-Down beim Boot**

```bash
docker compose stop mysql
docker compose restart bot
docker compose logs bot --tail=10
```

Expected: `Failed to reach MySQL:` + Container-Exit. Bot startet nicht.

Wiederherstellen:
```bash
docker compose start mysql
docker compose restart bot
```

- [ ] **Step 12: Test #10 — Parallel Bans (Race Test)**

Zwei Mods gleichzeitig in Discord:
- Mod A: `/ban @userA test race A`
- Mod B: `/ban @userB test race B`

Sofort.

Verify in DB:
```bash
docker compose exec -T mysql mysql -uoreo -p"$MYSQL_PASSWORD" -e "USE oreo; SELECT case_number, user_id FROM infractions WHERE type='ban' ORDER BY id DESC LIMIT 2;"
```

Erwartung: Zwei DIFFERENT case_number-Werte. Wenn beide dieselbe Nummer haben, ist das ein Bug — Race-Condition reproduziert (sollte mit `LAST_INSERT_ID`-Trick nicht passieren).

- [ ] **Step 13: Test-Daten aufräumen (optional)**

```bash
docker compose exec -T mysql mysql -uoreo -p"$MYSQL_PASSWORD" -e "USE oreo; DELETE FROM infractions; DELETE FROM guilds;"
```

- [ ] **Step 14: Final Commit (oder nichts wenn nur manuelle Tests)**

Wenn während der Verifikation Bugs auftauchten und behoben wurden: separater Commit. Sonst nichts.

---

## Self-Review-Notiz

Diese Implementierung folgt der Spec [docs/superpowers/specs/2026-05-30-warn-cases-design.md](../specs/2026-05-30-warn-cases-design.md). Abdeckung der Spec-Anforderungen:

- ✅ Persistente Speicherung in `infractions` — Tasks 1, 3
- ✅ Per-Server Case-Nummern — Task 3 (atomare `LAST_INSERT_ID`)
- ✅ `/warn` mit DM + Mod-Log — Task 5
- ✅ `/warnings` — Task 6
- ✅ `/case` — Task 7
- ✅ Bestehende Mod-Befehle schreiben in `infractions` — Tasks 8-12
- ✅ Forward-kompatibles Schema — Task 1 (alle 7 Tabellen)
- ✅ Schema-Setup beim Boot — Tasks 2, 4
- ✅ DM-Failure non-fatal — Task 5
- ✅ Mod-Log-Failure non-fatal — alle Befehle (bestehendes Pattern erhalten)
- ✅ DB-Down beim Boot → crash-loud — Task 4 + Test #9
- ✅ Manuelle Test-Checkliste — Task 13
