# Warn-System + Case-ID-Infrastruktur (Stage 1)

**Status:** Approved
**Datum:** 2026-05-30
**Projekt:** Oreo Discord Bot
**Autor:** Brainstorming-Session Lukas + Claude

---

## Kontext & Motivation

Der Oreo Discord Bot hat aktuell sechs Moderations-Befehle (`ban`, `unban`, `kick`, `timeout`, `untimeout`, `ping`). Alle Mod-Log-Embeds enthalten den Platzhalter `Case ID: TODO`, weil bisher keine persistente Speicherung von Mod-Aktionen existiert.

Gleichzeitig wurde in `server/Home Database Scheme.mwb` ein deutlich größerer DB-Entwurf skizziert, der über reines Case-Tracking hinausgeht: User-Reports, per-Server-Konfiguration, Custom-Bot-Permissions, Automod-Ausnahmen und ein Currency-System. Dieser Spec implementiert **Stage 1** einer mehrstufigen Roadmap:

- **Stage 1 (dieser Spec):** Volles Schema + Warn-System + Case-IDs für alle Mod-Aktionen
- **Stage 2 (späterer Spec):** Reports + `/config` für per-Server-Channels
- **Stage 3 (späterer Spec):** Auto-Eskalation + Role-Permissions
- **Stage 4 (späterer Spec):** Automod
- **API (eigenes Projekt):** Express-Server als Dashboard-Backend

---

## Ziele

1. Persistente Speicherung aller Mod-Aktionen in MySQL (`infractions`-Tabelle)
2. Fortlaufende, per-Server eindeutige Case-Nummern (Case #1, #2, ...)
3. Neuer `/warn`-Befehl mit DM-Benachrichtigung und Mod-Log
4. `/warnings`-Befehl zur Anzeige aller Warnungen eines Users
5. `/case <nummer>`-Befehl zum Nachschlagen jeder Mod-Aktion
6. Bestehende Mod-Befehle (`ban`, `unban`, `kick`, `timeout`, `untimeout`) schreiben in `infractions` und ersetzen `Case ID: TODO` durch echte Nummern
7. Forward-kompatibles Schema: alle Tabellen für Stages 2-4 werden in Stage 1 angelegt (aber nicht aktiv genutzt)

## Nicht-Ziele

- Keine Auto-Eskalation (Schema unterstützt es via `escalation_rules`, aber kein Read-Path)
- Keine Warn-Expiry-Cron-Jobs (Schema-Spalte `expires_at` existiert)
- Kein `/removewarn` oder `/clearwarns`
- Keine Pagination auf `/warnings` (Limit 25 reicht)
- Kein `/config`-Befehl — Channels weiterhin via `.env`
- Keine Test-Suite (manuelle Checkliste, siehe Testing)
- Keine REST-API
- Keine Reports/Automod/Currency-Logik

---

## Architektur

```
src/
├── db.js              (bestehend) — mysql2 Connection Pool
├── schema.js          (NEU)       — ensureSchema() liest server/schema.sql, idempotent
├── cases.js           (NEU)       — Repository: createCase, getCaseByNumber, listWarnings, ...
├── commands/
│   ├── ban.js         (EDIT)      — cases.createCase() statt "Case ID: TODO"
│   ├── kick.js        (EDIT)      — dito
│   ├── timeout.js     (EDIT)      — dito
│   ├── unban.js       (EDIT)      — dito
│   ├── untimeout.js   (EDIT)      — dito
│   ├── warn.js        (NEU)       — neuer Befehl
│   ├── warnings.js    (NEU)       — neuer Befehl
│   └── case.js        (NEU)       — neuer Befehl
└── index.js           (EDIT)      — ruft schema.ensureSchema() einmal vor client.login()

server/
├── Home Database Scheme.mwb  (bestehend) — MySQL Workbench Datei (visuelle Referenz)
└── schema.sql                (NEU)       — Canonical SQL-Source-of-Truth
```

### Design-Prinzipien

- **Repository Pattern:** `cases.js` ist die einzige Stelle, die `infractions`/`guilds`-Tabellen berührt. Keine inline-SQL in Befehls-Files.
- **Schema-Setup beim Boot:** `schema.ensureSchema()` läuft idempotent vor `client.login()`. Kein separates Migrations-Tool — solange das Schema nur erweitert wird, reicht `CREATE TABLE IF NOT EXISTS`.
- **DB ist Wahrheit, Discord-Side-Effects sind Best-Effort:** Wenn der Case in der DB steht, gilt die Aktion. DM-Fehler / Mod-Log-Fehler werden geloggt, blockieren aber nicht.
- **Crash-loud bei DB-Down beim Boot:** Bot stirbt mit klarer Meldung. Docker-Restart-Policy kümmert sich um Recovery.

---

## Datenbank-Schema

Canonical: [server/schema.sql](../../../server/schema.sql)

### Tabellen (Stage 1 — angelegt)

#### `guilds` — Per-Server-Konfiguration + Case-Counter

```sql
CREATE TABLE IF NOT EXISTS guilds (
  guild_id              BIGINT UNSIGNED PRIMARY KEY,
  report_channel_id     BIGINT UNSIGNED NULL,
  mod_log_channel_id    BIGINT UNSIGNED NULL,
  automod_enabled       TINYINT(1) NOT NULL DEFAULT 0,
  next_case_number      INT UNSIGNED NOT NULL DEFAULT 0,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

- `next_case_number`: Counter für `LAST_INSERT_ID`-Trick. Default 0, weil der Counter beim Claim erst auf 1 inkrementiert wird. Atomar inkrementiert via `UPDATE ... SET n = LAST_INSERT_ID(n+1)`.
- `report_channel_id` / `mod_log_channel_id`: Stage 2 — in Stage 1 wird weiterhin `MODLOG_CHANNEL_ID` aus `.env` gelesen.

#### `guild_users` — User-Profil pro (guild, user)

```sql
CREATE TABLE IF NOT EXISTS guild_users (
  guild_id    BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  username    VARCHAR(32) NULL,
  currency    INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (guild_id, user_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
);
```

- `currency`: für späteres Economy-Subsystem. In Stage 1 default 0, kein Read/Write.
- Stage 1 schreibt diese Tabelle **nicht aktiv**.

#### `infractions` — Alle Mod-Aktionen

```sql
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
```

- `case_number` ist pro `guild_id` fortlaufend (User-UX), nicht global.
- `active=0` reserviert für späteres `/removewarn` und für aufgehobene Timeouts (untimeout setzt es nicht — untimeout ist eine *neue* Infraktion vom type `untimeout`).
- `idx_user_lookup` deckt die `/warnings`-Query ab (WHERE guild_id + user_id + type + active).

#### Stage-2/3/4-Tabellen (angelegt, in Stage 1 ungenutzt)

```sql
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

CREATE TABLE IF NOT EXISTS escalation_rules (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  guild_id          BIGINT UNSIGNED NOT NULL,
  warn_threshold    INT UNSIGNED NOT NULL,
  action            ENUM('timeout','kick','ban') NOT NULL,
  duration_minutes  INT UNSIGNED NULL,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  UNIQUE KEY uq_threshold_per_guild (guild_id, warn_threshold)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  guild_id    BIGINT UNSIGNED NOT NULL,
  role_id     BIGINT UNSIGNED NOT NULL,
  permission  ENUM('helper','mod','admin') NOT NULL,
  PRIMARY KEY (guild_id, role_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS automod_exemptions (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  guild_id     BIGINT UNSIGNED NOT NULL,
  target_type  ENUM('user','role','channel') NOT NULL,
  target_id    BIGINT UNSIGNED NOT NULL,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  UNIQUE KEY uq_exemption (guild_id, target_type, target_id)
);
```

### Wichtige Abweichungen vom ursprünglichen .mwb-Entwurf

| Änderung | Grund |
|---|---|
| `users` → `guild_users` mit Composite PK `(guild_id, user_id)` | Multi-Tenant: currency/state pro Server. |
| `users.warns INT` entfernt | Derivable aus `infractions WHERE type='warn' AND active=1`. |
| `guilds.next_case_number` hinzugefügt | Atomarer Counter für User-freundliche Case-IDs. |
| `infractions.case_number` + Unique `(guild_id, case_number)` | "Case #4" pro Server statt globaler IDs. |
| `guild_id` + FK auf alle multi-tenant Tabellen | Multi-Tenant-Sicherheit + `ON DELETE CASCADE`. |
| `reports.evidence` → `evidence_url` | Klarere Semantik. |
| `reports.resolution_note` hinzugefügt | Mod-Kommentar beim Schließen. |
| `role_permissions.permission` als ENUM `('helper','mod','admin')` | Definierte Stufen. |

---

## Befehls-Spezifikationen

### `/warn user:<User> reason:<String?>`

- **Permission (Discord-Side):** `ModerateMembers`
- **Guards (in Reihenfolge):**
  1. Target ist Member des Servers
  2. Target ≠ Bot
  3. Target ≠ Mod selbst
  4. Target ≠ Server-Owner
  5. Mod-Rolle ist höher als Target-Rolle
- **Side-Effects (in Reihenfolge):**
  1. `cases.createCase({ type: 'warn', ... })` → `{ caseNumber }` (reason NULL wenn nicht angegeben)
  2. DM an Target: *„Du wurdest auf **{Server}** verwarnt.\nGrund: {reason ?? 'Kein Grund angegeben'}\nCase #{n}"* — Fehler non-fatal, `dmFailed=true`
  3. Mod-Log-Embed in `mod_log_channel` (gelb, ⚠️) mit Case-Nr, Mod, User, Grund, Timestamp, ggf. „DM nicht zugestellt"
  4. Ephemeral Reply: *„{Username} verwarnt (Case #{n})"*

### `/warnings user:<User> [include_inactive:Bool=false]`

- **Permission:** `ModerateMembers`
- **Query:** `cases.listWarnings(guildId, userId, { includeInactive })`
- **Reply:** Embed mit bis zu 25 Feldern (Case-Nr, Datum, Grund, Mod-Mention)
- **Footer:** *„Aktive Warns: X · Gesamt: Y"*

### `/case number:<Integer>`

- **Permission:** `ModerateMembers`
- Sucht jede Action-Art via Case-Nummer
- **Reply:** Embed mit User, Mod, Type (lokalisiert), Grund, Created-At, Duration, Active, Source
- Nummer existiert nicht → ephemeral „Case #N nicht gefunden"

### Bestehende Befehle: Edit

Alle fünf (`ban`, `unban`, `kick`, `timeout`, `untimeout`) bekommen denselben Edit vor dem Mod-Log-Embed:

```js
const { caseNumber } = await cases.createCase({
  guildId: interaction.guildId,
  userId: target.id,
  moderatorId: interaction.user.id,
  type: 'ban',
  reason,
  durationMs: durationMs ?? null,
  expiresAt: timeoutEndsAt ?? null,
});
```

`caseNumber` ersetzt `Case ID: TODO` im Embed-Footer.

### `cases.js` Public API

```js
exports.createCase = async ({
  guildId, userId, moderatorId, type, reason,
  durationMs = null, expiresAt = null, source = 'manual'
}) => ({ caseNumber, infractionId });

exports.getCaseByNumber = async (guildId, caseNumber) => Infraction | null;

exports.listWarnings = async (guildId, userId, { includeInactive = false, limit = 25 } = {}) => Infraction[];

exports.countActiveWarnings = async (guildId, userId) => number;

exports.deactivate = async (guildId, caseNumber) => boolean;
```

---

## Datenfluss

### Bot-Startup

```
index.js
  └─► schema.ensureSchema()        ← NEU, vor Login
        └─► liest server/schema.sql
        └─► executet jede Statement
  └─► REST.put(...) — Commands deployen
  └─► client.login()
```

DB nicht erreichbar beim Boot → Bot bricht ab mit klarer Meldung.

### `/warn`-Lebenszyklus

```
1. InteractionCreate → commands/warn.js execute()
2. Guards prüfen        → bei Fail: ephemeral Reply, return
3. cases.createCase()   → bei DB-Fail: ephemeral „Datenbankfehler", return
4. target.send(dm)      → bei Fail: dmFailed=true, weiter
5. modLog.send(embed)   → bei Fail: ephemeral followUp warnen
6. interaction.reply()  → bei Fail (Timeout): catch & ignore
```

### Fehler-Matrix

| Stufe | Fehlerart | Verhalten | DB-Zustand |
|---|---|---|---|
| Guards | nicht im Server / Owner / höhere Rolle | Abbruch | unverändert |
| createCase | MySQL down / Constraint | Abbruch + Console-Error | rollback (konsistent) |
| target.send | DMs aus | weiter, dmFailed=true | Case existiert ✓ |
| modLog.send | Channel fehlt / Bot-Perms | weiter | Case existiert ✓ |
| interaction.reply | Timeout (>3s) | Catch & ignore | Case existiert ✓ |

**Leitprinzip:** Die DB ist Wahrheit, alles andere ist Best-Effort.

### Transaktions-Pattern in `cases.createCase`

```js
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();

  // 1. Guild-Row sicherstellen.
  await conn.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [guildId]);

  // 2. Counter atomar inkrementieren.
  await conn.execute(
    'UPDATE guilds SET next_case_number = LAST_INSERT_ID(next_case_number + 1) WHERE guild_id = ?',
    [guildId]
  );

  // 3. Neuen case_number auslesen.
  const [[row]] = await conn.query('SELECT LAST_INSERT_ID() AS caseNumber');
  const caseNumber = row.caseNumber;

  // 4. Infraction speichern.
  const [result] = await conn.execute(
    `INSERT INTO infractions
       (guild_id, case_number, user_id, moderator_id, type, source, reason, duration_ms, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [guildId, caseNumber, userId, moderatorId, type, source, reason, durationMs, expiresAt]
  );

  await conn.commit();
  return { caseNumber, infractionId: result.insertId };
} catch (err) {
  await conn.rollback();
  throw err;
} finally {
  conn.release();
}
```

Das `UPDATE` setzt einen Row-Lock auf die `guilds`-Zeile. Parallele `createCase`-Aufrufe für denselben Server serialisieren sich am Lock — kein Risiko für duplizierte Case-Nummern.

---

## Testing

Das Projekt hat keine Test-Suite. Manuelle Test-Checkliste in der PR-Beschreibung.

| # | Szenario | Erwartung |
|---|---|---|
| 1 | `/warn` neuer User | DM ankommt, Mod-Log mit Case #1, ephemeral „Case #1" |
| 2 | `/warn` zweiter User | Case #2 |
| 3 | `/warn` Owner | Abbruch „kann nicht gewarnt werden" |
| 4 | `/warn` User mit DMs aus | Mod-Log: „DM nicht zugestellt", Case in DB |
| 5 | `/warnings @user` (3 Warns) | Embed mit 3 Feldern, Footer „Aktive: 3 · Gesamt: 3" |
| 6 | `/case 1` | Vollständiger Case-Embed |
| 7 | `/case 9999` | „Case nicht gefunden" |
| 8 | `/ban` + `/case <neue Nr>` | Funktioniert über Action-Typen hinweg |
| 9 | DB-Container stoppen, Bot restart | Crash mit klarer MySQL-Fehlermeldung |
| 10 | Zwei Mods parallel bannen | Unterschiedliche Case-Nummern (Race-Test) |

---

## Roll-out

1. PR mergen → `main`
2. `docker compose up -d --build` auf Server
3. Beim Boot legt `schema.ensureSchema()` alle Tabellen an (idempotent)
4. Bot deployt Slash-Befehle automatisch
5. Befehle erscheinen in Discord innerhalb Sekunden (Guild-Commands)

**Rollback:** Vorherigen Container-Tag re-deployen. Kein Schema-Drop nötig.

---

## Offene Punkte / Folge-Specs

- **Stage 2:** Reports-Subsystem + `/config`-Befehl
- **Stage 3:** Auto-Eskalation + Custom Role-Permissions
- **Stage 4:** Automod (neue `automod_rules`-Tabelle erforderlich)
- **API:** Express-Server mit Discord-OAuth2
