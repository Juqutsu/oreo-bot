# Case-Management (Stage 1.5)

**Status:** Approved
**Datum:** 2026-05-30
**Projekt:** Oreo Discord Bot
**Branch:** `feat/warn-cases-stage1` (Stage 1.5 wird auf demselben Branch implementiert)
**Spec-Vorgänger:** [2026-05-30-warn-cases-design.md](2026-05-30-warn-cases-design.md)

---

## Kontext & Motivation

Stage 1 hat das `infractions`-System mit per-Server Case-Nummern und einem `/warn`/`/warnings`/`/case`-Set geliefert. Mods können jetzt Verwarnungen aussprechen und nachschlagen, aber:

- **Keine Korrektur-Möglichkeit:** Wenn eine Verwarnung falsch war, gibt es keinen Weg sie zurückzunehmen.
- **Keine Reason-Edits:** Tippfehler oder unklare Begründungen bleiben für immer.
- **Begrenzte Übersicht:** `/warnings` zeigt nur Warnungen, nicht die gesamte Mod-Historie eines Users (Bans, Kicks, Timeouts).

Diese Stage 1.5 schließt die Lücke mit drei zusätzlichen Befehlen, plus einem System für **nachvollziehbare Audit-Trails** (Soft-Delete + Meta-Cases).

---

## Ziele

1. `/removewarn <case_number> [reason]` — Verwarnung als entfernt markieren (Soft-Delete), Audit-Case erstellen
2. `/modhistory <user>` — komplette Mod-Historie eines Users (alle Action-Typen)
3. `/reason <case_number> <new_reason>` — Reason eines Cases nachträglich korrigieren, Audit-Case erstellen
4. Schema-Evolution-Pattern etablieren (ALTER TABLE in `schema.sql`)
5. Meta-Case-Modell: Audit-Aktionen sind selbst Cases mit eigener Nummer und Verbindung zum Original

## Nicht-Ziele

- Keine Hard-Deletes (`DELETE FROM infractions` ist verboten — Audit-Integrität)
- Keine Pagination (Limit 25, älter via `/case <nr>`)
- Keine bulk-Operationen (`/clearwarns @user` etc.)
- Keine Edit-Permissions je Mod (jeder mit `ModerateMembers` kann alles)
- Keine separate Audit-Tabelle (Meta-Cases bleiben in `infractions`)
- Kein eigenes Migrations-Tool (CREATE TABLE IF NOT EXISTS + idempotente ALTER bleiben das Pattern)

---

## Architektur (Delta zu Stage 1)

```
src/
├── cases.js                (EDIT)  — 3 neue Funktionen: listUserInfractions, removeWarn, editReason
├── commands/
│   ├── case.js             (EDIT)  — TYPE_LABELS/COLORS für warn_removed/reason_edited, parent_case_number Display
│   ├── removewarn.js       (NEU)
│   ├── modhistory.js       (NEU)
│   └── reason.js           (NEU)
└── (schema.js unverändert) — der existierende Loader handhabt die neuen ALTER-Statements
server/
└── schema.sql              (EDIT)  — neuer "ALTER STATEMENTS"-Block am Ende
```

### Design-Prinzipien

- **Append-only mit Soft-Delete:** Keine Zeile wird je gelöscht. Status-Änderungen erfolgen via `active`-Flag oder neue Meta-Cases.
- **Meta-Cases sind echte Cases:** Sie haben eine `case_number`, tauchen in `/case <nr>` auf, werden via `parent_case_number` mit dem Original verbunden.
- **`SELECT ... FOR UPDATE`** für Read-Modify-Write-Logik (verhindert Race-Conditions bei parallelen `/removewarn` auf denselben Case).
- **Meta-Cases werden in `/warnings` und `/modhistory` herausgefiltert:** Sie verschmutzen die Listen nicht, sind aber einzeln einsehbar.

---

## Datenbank-Erweiterung

### Schema-Änderungen (additiv zu Stage 1)

In `server/schema.sql` wird unten ein neuer Block angehängt:

```sql
-- =========================================================
-- ALTER STATEMENTS (run after CREATE TABLE, idempotent)
-- =========================================================

-- Neue ENUM-Werte: warn_removed, reason_edited.
-- MODIFY COLUMN ist idempotent — MySQL setzt die Spalten-Definition auf den Soll-Zustand.
ALTER TABLE infractions MODIFY COLUMN type
  ENUM('warn','timeout','kick','ban','unban','untimeout','warn_removed','reason_edited') NOT NULL;

-- parent_case_number: Verbindung von Meta-Cases zum Original.
-- IF NOT EXISTS ab MySQL 8.0.29 (April 2022). Falls dein MySQL älter ist, schlägt der Bot beim
-- zweiten Boot-Versuch mit errno 1060 fehl — Fix wäre dann ein Check in schema.js (catch errno).
ALTER TABLE infractions ADD COLUMN IF NOT EXISTS
  parent_case_number INT UNSIGNED NULL AFTER case_number;
```

**`schema.js`-Verhalten:** Der bestehende Loader (`server/schema.sql` → split on `;` → loop `pool.query`) braucht keine Anpassung. ALTER-Statements werden einfach mit ausgeführt.

### Erwartetes Schema nach Migration

`infractions`-Tabelle:

| Spalte | Typ | NEU? |
|---|---|---|
| id | BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT | nein |
| guild_id | BIGINT UNSIGNED NOT NULL | nein |
| case_number | INT UNSIGNED NOT NULL | nein |
| **parent_case_number** | **INT UNSIGNED NULL** | **JA** |
| user_id | BIGINT UNSIGNED NOT NULL | nein |
| moderator_id | BIGINT UNSIGNED NOT NULL | nein |
| type | ENUM(...8 Werte) NOT NULL | **erweitert** |
| source | ENUM(...) NOT NULL | nein |
| reason | VARCHAR(512) NULL | nein |
| duration_ms | BIGINT UNSIGNED NULL | nein |
| expires_at | DATETIME NULL | nein |
| active | TINYINT(1) NOT NULL DEFAULT 1 | nein |
| created_at | DATETIME NOT NULL | nein |

`parent_case_number` ist `NULL` für reguläre Aktionen, gefüllt für Meta-Cases.

### Migrationsstrategie (für die Zukunft)

Sobald `server/schema.sql` 5+ ALTER-Statements hat, ist es Zeit für ein echtes Migrations-System (nummerierte SQL-Dateien + `schema_migrations`-Tabelle). Heute reicht das simple Pattern.

---

## `cases.js` Public API (Erweiterung)

Bestehende Exports bleiben unverändert. Drei neue:

```js
/**
 * Listet ALLE Infractions eines Users (alle Typen außer Meta-Cases).
 * Für /modhistory.
 * Default includeInactive=true (zeigt entfernte Warns mit Badge).
 */
exports.listUserInfractions = async (guildId, userId, { includeInactive = true, limit = 25 } = {}) => Infraction[];

/**
 * Soft-Delete einer Warnung. Setzt active=0 + erstellt Meta-Case (type='warn_removed').
 * Transaktional mit SELECT ... FOR UPDATE Lock.
 * @returns {Promise<{metaCaseNumber: number}|null>}
 *   null wenn: Original existiert nicht, ist kein Warn, oder ist bereits active=0
 */
exports.removeWarn = async ({ guildId, originalCaseNumber, moderatorId, reason = null }) => result | null;

/**
 * Editiert den Reason eines bestehenden Cases.
 * Überschreibt das reason-Feld + erstellt Meta-Case (type='reason_edited') mit Alt/Neu-Diff.
 * Repository-Funktion ist typ-agnostisch — die Meta-Case-Schutz-Logik liegt im
 * /reason-Command (separation of concerns: repo macht Daten-Ops, Command macht Validation).
 * @returns {Promise<{metaCaseNumber: number, oldReason: string|null}|null>}
 *   null wenn Original-Case nicht existiert
 */
exports.editReason = async ({ guildId, originalCaseNumber, moderatorId, newReason }) => result | null;
```

### Wichtige Implementation-Details

**`removeWarn` Transaktion:**

```js
const conn = await getPool().getConnection();
try {
  await conn.beginTransaction();

  // 1. Original laden + lock.
  const [[original]] = await conn.execute(
    'SELECT id, user_id, type, active FROM infractions WHERE guild_id = ? AND case_number = ? FOR UPDATE',
    [guildId, originalCaseNumber],
  );
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
```

**`editReason` Transaktion:** Identische Struktur, aber:
- Lädt zusätzlich `reason` als `oldReason`
- Updated `reason` statt `active`
- Meta-Case Reason ist `"Alt: ${oldReason ?? '(leer)'} → Neu: ${newReason ?? '(leer)'}"`

**`listUserInfractions` Query:**

```sql
SELECT * FROM infractions
WHERE guild_id = ? AND user_id = ?
  AND type NOT IN ('warn_removed', 'reason_edited')
  [AND active = 1]  -- nur wenn includeInactive=false
ORDER BY created_at DESC
LIMIT ?
```

Wichtig: Meta-Cases sind ausgeschlossen, damit die Mod-Historie nicht von Audit-Lärm überflutet wird. Sie sind via `/case <metaCaseNr>` einsehbar.

---

## Befehls-Spezifikationen

### `/removewarn case_number:<Integer> reason:<String?>`

| Permission | Guards | Side-Effects |
|---|---|---|
| `ModerateMembers` | (1) Case existiert, (2) ist `type='warn'`, (3) ist `active=1` | DB-Write → DM (Best-Effort) → Reply → Mod-Log |

**Replies:**
- Erfolg: ephemeral *„Verwarnung Case #{n} entfernt (Audit Case #{metaCaseNumber})."*
- Case nicht gefunden: *„Case #{n} nicht gefunden."*
- Falscher Type: *„Case #{n} ist kein Warn (Type: {actualType})."*
- Schon entfernt: *„Case #{n} ist bereits entfernt."*
- DB-Failure: *„Datenbankfehler — versuch's später."*

**DM-Text:**
> Eine Verwarnung auf **{Server}** wurde aufgehoben.
> Case #{original} — Aufgehoben von <@mod>
> Grund: {reason ?? 'Kein Grund angegeben'}

**Mod-Log-Embed:** Grüne Farbe (0x57f287), Titel *„✅ Verwarnung entfernt"*, Felder: User, Mod, Original-Case-Nr, Grund. Footer: `Case #{metaCaseNumber} · 🐾`.

### `/modhistory user:<User> [include_inactive:Bool=true]`

| Permission | Query | Display |
|---|---|---|
| `ModerateMembers` | `listUserInfractions(guildId, userId, { includeInactive, limit: 25 })` | Embed mit Type-Icon pro Eintrag |

**Empty:** ephemeral *„{Username} hat keine Mod-Historie."*

**Embed-Felder:**
- Name: `{TYPE_ICON} Case #{n}{[ENTFERNT] wenn !active}`
- Value: `{discordTimestamp}\nvon <@mod>\n{reason ?? 'Kein Grund angegeben'}`

**Footer:** *„Insgesamt angezeigt: X · 🐾"*

### `/reason case_number:<Integer> new_reason:<String>` (required)

| Permission | Guards | Side-Effects |
|---|---|---|
| `ModerateMembers` | (1) Case existiert, (2) NICHT Meta-Case, (3) Reason unterscheidet sich | DB-Write → Reply → Mod-Log (KEIN DM) |

**Replies:**
- Erfolg: ephemeral *„Grund für Case #{n} aktualisiert (Audit Case #{metaCaseNumber})."*
- Case nicht gefunden: *„Case #{n} nicht gefunden."*
- Meta-Case: *„Audit-Cases (warn_removed/reason_edited) können nicht editiert werden."*
- Unverändert: *„Neuer Grund ist identisch zum bestehenden — Abbruch."*
- DB-Failure: *„Datenbankfehler — versuch's später."*

**Mod-Log-Embed:** Blaue Farbe (0x5865f2), Titel *„📝 Grund editiert"*, Felder: User, Mod, Original-Case-Nr, Alt-Grund, Neu-Grund. Footer: `Case #{metaCaseNumber} · 🐾`.

### Erweiterung von `/case <number>` (Edit in `case.js`)

Zwei kleine Verbesserungen:

1. **TYPE_LABELS** und **TYPE_COLORS** erweitern:
   ```js
   warn_removed: '✅ Verwarnung entfernt'  / color 0x57f287
   reason_edited: '📝 Grund editiert'      / color 0x5865f2
   ```

2. **Wenn `c.parent_case_number` gesetzt ist**, neues Embed-Feld: `🔗 Bezogen auf Case #{parent}` (inline).

---

## Fehlerverhalten

| Situation | Verhalten | DB-Zustand |
|---|---|---|
| `/removewarn` auf bereits entferntem Case | Abbruch, ephemeral „bereits entfernt" | Original unverändert, kein Meta-Case |
| Zwei Mods `/removewarn 5` parallel | Erster gewinnt (`FOR UPDATE`-Lock), zweiter sieht „bereits entfernt" | Konsistent (Lock + active=0 Check) |
| `/reason` mit identischem Wert | Abbruch, kein Meta-Case | Original unverändert |
| `/modhistory` für User ohne Cases | ephemeral „keine Mod-Historie" | unverändert |
| DB-Failure mitten in Transaktion | `rollback()` + ephemeral Fehlermeldung | Original unverändert (Transaktions-Atomarität) |

**Leitprinzip:** Sobald die Transaktion committed, gilt die Aktion. Wenn ein Best-Effort-Schritt (DM, Mod-Log) danach fehlschlägt, bleibt der Case in der DB persistiert.

---

## Testing (manuell)

| # | Szenario | Erwartung |
|---|---|---|
| 1 | `/removewarn 1 falsche Verwarnung` | DM bei Target, ephemeral „entfernt (Audit Case #N)", grüner Mod-Log |
| 2 | `/warnings @target` nach Removal | Case #1 nicht mehr in der Liste |
| 3 | `/warnings @target include_inactive:true` | Case #1 mit Badge `[ENTFERNT]` |
| 4 | `/case 1` (nach Removal) | Type `warn`, Active `Nein`, Grund unverändert |
| 5 | `/case <metaCaseNr>` | Type `✅ Verwarnung entfernt`, Feld `🔗 Bezogen auf Case #1` |
| 6 | `/removewarn 1` nochmal | „Case #1 ist bereits entfernt." |
| 7 | `/removewarn 9999` | „Case #9999 nicht gefunden." |
| 8 | `/removewarn <ban-case-nr>` | „Case #N ist kein Warn (Type: ban)." |
| 9 | `/modhistory @target` | Alle Action-Typen in einer Liste, sortiert nach Datum |
| 10 | `/reason 2 präzisierter Grund` | ephemeral „aktualisiert", Mod-Log mit Alt/Neu |
| 11 | `/case 2` nach Edit | Neuer Reason sichtbar, active=1 |
| 12 | `/case <metaCaseNr>` vom Edit | Reason `Alt: ... → Neu: ...` |
| 13 | `/reason <metaCaseNr> ...` | „Audit-Cases können nicht editiert werden." |
| 14 | `/reason 2 X` zweimal identisch | „Neuer Grund ist identisch — Abbruch." |
| 15 | Race: zwei Mods `/removewarn 1` parallel | Einer kriegt Audit-Case, der andere „bereits entfernt" |

---

## Roll-out

**Branch:** `feat/warn-cases-stage1` (gleicher Branch wie Stage 1). PR enthält am Ende beide Stages zusammen.

**Deploy:**
1. PR mergen
2. `docker compose up -d --build` auf Server
3. Bot-Start: `ensureSchema()` führt CREATE TABLE IF NOT EXISTS (no-op) + neue ALTER-Statements aus
4. Bot deployt neue Slash-Commands automatisch
5. Befehle erscheinen in Discord innerhalb Sekunden

**Rollback-Plan:** Vorherigen Container-Tag re-deployen. Schema bleibt vorwärtskompatibel — `parent_case_number` wird von Stage-1-Code einfach ignoriert.

---

## Offene Punkte / Folge-Specs

Nichts in scope hier — alles für spätere Stages reserviert:

- **Stage 2:** Reports + `/config` für per-Server-Channels
- **Stage 3:** Auto-Eskalation (escalation_rules aktivieren) + Custom Role-Permissions
- **Stage 4:** Automod (neue `automod_rules`-Tabelle)
- **Migrations-Tool:** ab 5+ ALTER-Statements in schema.sql
- **API:** Express-Server mit Discord-OAuth2
