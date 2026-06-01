# Stage 2d — Deferred Items Design

**Date:** 2026-06-01
**Status:** Approved (brainstorming session)
**Author:** Lukas (mit Claude Opus 4.7)
**Supersedes Anonymity-Rule:** Stage 2c §6.5 (siehe §4.4 unten)

---

## 1. Ziel

Drei in Stage-2c-Spec §11 als "Future Work" verschobene Items als kohärentes Stage-2d-Paket implementieren:

1. **Mod-Log-Builder-Refactor** — zentrale Embed-Factory `src/modlog.js`, alle 5 Producer migriert.
2. **`/case <N>` Reverse-Lookup** — `/case` zeigt Report-Quelle, wenn der Case aus einem Report kam.
3. **`/config channel set type:report` Permission-Check** — warnt, wenn moderator+ Rollen den Channel nicht sehen können.

Die drei Items sind unabhängig (kein Cross-Coupling im Code-Pfad), passen aber gut in eine gemeinsame Stage, weil sie alle "Polish" für das in Stage 2c gebaute Report-System sind.

## 2. Out-of-Scope

- **Mod-Log Fetch+Send-Pipeline-Refactor** — bleibt pro Command inline. `src/modlog.js` ist nur Builder.
- **Permission-Check für `type:mod_log`** — bewusst nur `type:report`.
- **`/report list` / `/report show <id>`** — eigene Stage.
- **Re-Open / Un-Claim für Reports** — YAGNI per Stage-2c-Decision.
- **Reporter-DMs / Automod-Integration** — Stage 3/4.
- **Automatischer Cleanup orphaned `guild_role_tiers`-Rows** (Rolle gelöscht aber DB-Eintrag bleibt) — wird im Perm-Check fail-soft behandelt, aber kein expliziter Cleanup-Job.
- **`untimeout` / `unban` / `removewarn` / `reason_edited` Mod-Log-Embeds** — die haben heute eigene unverwandte Layouts und werden in dieser Stage NICHT in `modlog.js` aufgenommen. Nur die vier Punishment-Actions (`warn`, `timeout`, `kick`, `ban`) sind Teil von Spec §11's "duplizierter Code".

## 3. Item 1 — `src/modlog.js`

### 3.1 Architektur

Neues Modul `src/modlog.js` mit einer exportierten Funktion `buildModLogEmbed(opts)`. Liefert `EmbedBuilder` (nicht ein vollständiges Message-Object), damit Caller noch `.addFields()` etc. anhängen können bevor sie senden.

```js
// src/modlog.js
const { EmbedBuilder } = require('discord.js');
const { formatDuration } = require('./duration');

const COLOR_WARN = 0xfaa61a;
const COLOR_TIMEOUT = 0xfaa61a;
const COLOR_KICK = 0xed4245;
const COLOR_BAN = 0xed4245;

function buildModLogEmbed({ action, caseNumber, target, mod, reason, durationMs, dmFailed = false }) {
  // Dispatch nach action; konkrete Field-Layouts pro Variante in §3.2.
  // Gemeinsame Helper:
  //   footer       = caseNumber ? `Case #${caseNumber} · 🐾` : 'Case-Eintrag fehlgeschlagen · 🐾'
  //   reasonValue  = reason ?? 'Kein Grund angegeben'
  // Rückgabe: EmbedBuilder oder null für unbekannte action.
}

module.exports = { buildModLogEmbed };
```

### 3.2 Kanonische Layouts

Layout-Quelle: die bestehende `buildModLogEmbed`-Funktion in `src/interactions/report.js` (kommt aus Stage 2c, ist das vollständigste Layout).

**warn** (Color `0xfaa61a`):
- Title: `⚠️ User verwarnt`
- Thumbnail: `target.displayAvatarURL({ size: 256 })`
- Fields:
  - `👤 User` = `<@target.id>` (inline=false)
  - `🛡️ Moderator` = `<@mod.id>` (inline=false)
  - `📝 Grund` = `reasonValue` (inline=false)
  - Conditional, wenn `dmFailed===true`: `📬 DM` = `'Nicht zugestellt (DMs aus?)'` (inline=false)
- Footer: `footer`
- Timestamp: `setTimestamp()`

**timeout** (Color `0xfaa61a`):
- Title: `⏱️ Timeout vergeben`
- Thumbnail: `target.displayAvatarURL({ dynamic: true })`
- Fields:
  - `User` = `<@target.id>` (inline=true)  ← **bewusste Änderung gegenüber heutigem timeout.js: kein `(username)`-Suffix**
  - `Moderator` = `<@mod.id>` (inline=true)  ← gleiche Änderung
  - `Grund` = `reasonValue` (inline=false)
  - `Dauer` = `formatDuration(durationMs)` (inline=true)
  - `Läuft ab` = `<t:${expSec}:f>` mit `expSec = Math.floor((Date.now()+durationMs)/1000)` (inline=true)
- Footer: `footer`
- Timestamp: `setTimestamp()`

**kick** (Color `0xed4245`):
- Title: `User gekickt` (kein Emoji — bewusst, weil Stage 2c-Layout es so hatte)
- Thumbnail: `target.displayAvatarURL({ size: 256 })`
- Fields:
  - `👤 User` = `<@target.id>` (inline=false)
  - `🛡️ Moderator` = `<@mod.id>` (inline=false)
  - `📝 Grund` = `reasonValue` (inline=false)
- Footer: `footer`
- Timestamp: `setTimestamp()`

**ban** (Color `0xed4245`):
- Title: `🔨 User gebannt`
- Thumbnail: `target.displayAvatarURL({ size: 256 })`
- Fields:
  - `👤 User` = `<@target.id>` (inline=false)
  - `🛡️ Moderator` = `<@mod.id>` (inline=false)
  - `📝 Grund` = `reasonValue` (inline=false)
- Footer: `footer`
- Timestamp: `setTimestamp()`

### 3.3 Migration

5 Producer wechseln auf `const { buildModLogEmbed } = require('../modlog');` (bzw. `'./modlog'` für `interactions/report.js`):

| Datei | Heutiger Code | Nachher |
|---|---|---|
| `src/commands/warn.js` | inline EmbedBuilder + DM-Field-Branch | `buildModLogEmbed({action:'warn', ..., dmFailed})` |
| `src/commands/timeout.js` | inline EmbedBuilder mit `(${target.username})` Suffix | `buildModLogEmbed({action:'timeout', ..., durationMs})` — Suffix entfällt |
| `src/commands/kick.js` | inline EmbedBuilder | `buildModLogEmbed({action:'kick', ...})` |
| `src/commands/ban.js` | inline EmbedBuilder | `buildModLogEmbed({action:'ban', ...})` |
| `src/interactions/report.js` | lokale `buildModLogEmbed`-Helperfunktion (Stage 2c) | Import aus `../modlog`, lokale Funktion gelöscht |

Pro Caller bleibt: Channel-Fetch, `.send()`, Fail-soft `followUp` bei Send-Fehler — diese Boilerplate ist out-of-scope dieser Stage.

### 3.4 Sichtbare Verhaltensänderungen

| Producer | Spürbare Änderung |
|---|---|
| warn.js (direkt) | Keine. DM-Field wird weiter conditional gesetzt. |
| timeout.js (direkt) | `User` und `Moderator` Fields verlieren den ` (${target.username})` Suffix. Mods sehen nur noch die Mention. Minimal noisiger Embed. |
| kick.js (direkt) | Keine. |
| ban.js (direkt) | Keine. |
| interactions/report.js | Keine. |

Diese Änderung ist bewusst — wir vereinheitlichen auf ein Layout statt 2 zu pflegen. Wenn der `(username)`-Suffix wichtig ist, kann er später als optional flag wieder rein.

### 3.5 Was NICHT in `modlog.js` ist
- Channel-Fetch / `.send()` — bleibt im Caller
- Fail-soft `followUp` ("Mod-Log nicht konfiguriert", "Eintrag fehlgeschlagen") — bleibt im Caller
- DM-Embed-Builder (separater Embed-Stil, nur warn nutzt es)
- `untimeout` / `unban` / `removewarn` / `reason_edited` Layouts (nicht Teil von Spec §11)

## 4. Item 2 — `/case <N>` Reverse-Lookup

### 4.1 DAL-Ergänzung in `src/reports.js`

Neue exportierte Funktion:

```js
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

Rückgabe: Report-Row mit den 5 Feldern oder `null`. Kein `SELECT *` (DAL-Konvention aus Stage 2c). `LIMIT 1` — 1 Case kann max 1 Report-Quelle haben (resolution_case_number wird genau einmal in `resolveReport` gesetzt).

Export-Liste in `src/reports.js`-`module.exports` bekommt `getReportByCaseNumber` als 11. Eintrag.

### 4.2 Schema-Migration

In `server/schema.sql` ein neuer Migration-Block angehängt:

```sql
-- ============================================================
-- Stage 2d Migration: /case Reverse-Lookup Index
-- ============================================================
-- Speedup für reports.getReportByCaseNumber(guildId, caseNumber).
-- Idempotent via schema-runner (siehe src/schema.js).

ALTER TABLE reports ADD INDEX idx_resolution_case (guild_id, resolution_case_number);
```

`src/schema.js`-Runner führt den Block bereits idempotent aus (siehe Stage-2c-Pattern memory 7568). Bei wiederholtem Run: Index existiert → MySQL wirft `ER_DUP_KEYNAME` (errno 1061) → Runner swallowed.

### 4.3 `/case`-Embed-Integration

In `src/commands/case.js`, direkt **nach** dem bestehenden `parent_case_number`-Block (vor dem `duration_ms`-Block):

```js
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

- Field-Position: nach `🔗 Bezogen auf`, vor `⏱️ Dauer`
- `inline: false` — Block-Layout, kollidiert nicht mit den inline-Fields
- Reporter wird als `<@id>`-Mention gerendert
- Kein Klick-Link zum Report-Embed (Stage 3 wenn gewünscht)

`src/commands/case.js` braucht neuen `require`: `const reports = require('../reports');` ganz oben (neben `cases`).

### 4.4 Anonymitäts-Spec-Update

**Diese Stage hebt Stage-2c-Spec §6.5 in einem konkreten Teilpunkt auf:**

Stage-2c-Spec §6.5 hatte zugesichert: "/case zeigt als Moderator den Resolver, niemals den Reporter — Anonymität endet nicht beim Status-Wechsel."

Stage 2d ersetzt diesen Satz durch:
> "/case <N> zeigt den Reporter, wenn der Case via Report-Resolve entstanden ist. Sichtbar ab `supporter`-Tier (gleicher Tier wie /case selbst). Die `#reports`-Channel-Anonymität (nur moderator+ Tier kann den Channel überhaupt sehen, kontrolliert per Discord-Permission) bleibt unverändert. Das neue Leak-Surface ist `/case` — Tier-gated auf supporter+."

**Begründung:** Mod-Workflow profitiert davon, beim Auditieren eines Cases den Kontext "wer hat das gemeldet" zu sehen. Supporter-Tier ist die Trust-Boundary; alles unterhalb (member, regular) hat keinen `/case`-Zugriff.

### 4.5 Fail-soft-Verhalten

| Fall | Verhalten |
|---|---|
| `reports.getReportByCaseNumber` wirft (DB-Fehler) | `linkedReport=null`, kein Quelle-Field, Rest des Cases zeigt normal. Warning in Console. |
| Case hat kein `resolution_case_number` (z.B. via `/warn` direkt) | DAL liefert `null`, kein Field. |
| Report wurde manuell aus DB gelöscht | DAL liefert `null`, kein Field. |
| Reporter hat den Server verlassen | Mention `<@id>` rendert weiterhin als unklickbare ID — OK. |

## 5. Item 3 — `/config channel set type:report` Permission-Check

### 5.1 Trigger-Bedingung
- Nur wenn `type === 'report'` (NICHT für `type:mod_log`)
- Läuft NACH dem bestehenden Bot-Permission-Check (SendMessages, EmbedLinks)
- Läuft VOR dem DB-Update — Warnung muss im selben Reply landen wie "Channel gesetzt"
- Fehler im Check → kein Crash, Channel-Set läuft trotzdem durch

### 5.2 Logik

In `src/commands/config.js` → `handleChannelSet`, neuer Block nach dem `EmbedLinks`-Check:

```js
let permissionWarnings = [];
if (type === 'report') {
  try {
    permissionWarnings = await collectReportPermWarnings(interaction.guild, channel);
  } catch (err) {
    console.warn('collectReportPermWarnings failed:', err);
    // fail-soft: keine Warning ist OK, Channel-Set läuft weiter
  }
}
```

Neuer Helper in `src/commands/config.js` (lokal, kein eigenes Modul):

```js
async function collectReportPermWarnings(guild, channel) {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT role_id FROM guild_role_tiers
       WHERE guild_id = ? AND tier IN ('moderator', 'owner')`,
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

**Tabellenname-Bestätigung:** `guild_role_tiers` ist der korrekte Tabellenname (Stage 2a Schema). Wenn ein zukünftiger Refactor das umbenennt, wird der Plan das aktualisieren.

### 5.3 Reply-Format

**Ohne Blocker** (identisch zum aktuellen Stage-2b-Reply):
```
✅ Report-Channel auf <#123> gesetzt.
```

**Mit Blockern** (neue Variante):
```
✅ Report-Channel auf <#123> gesetzt.

⚠️ Achtung: Folgende Mod-Rollen können den Channel nicht sehen: <@&111>, <@&222>
Bitte `View Channel`-Permission setzen, sonst sehen sie keine eingehenden Reports.
```

### 5.4 Längenkontrolle

Bei sehr vielen blockierten Rollen kann der Reply den 2000-Zeichen-Discord-Limit reißen. Pragmatisch:

```js
const MAX_ROLES_IN_WARNING = 10;
const shown = blocked.slice(0, MAX_ROLES_IN_WARNING).map(id => `<@&${id}>`).join(', ');
const overflow = blocked.length - MAX_ROLES_IN_WARNING;
const warnText = overflow > 0
  ? `${shown}, +${overflow} weitere`
  : shown;
```

### 5.5 Edge-Cases

| Fall | Verhalten |
|---|---|
| Keine moderator/owner Rolle konfiguriert (`rows=[]`) | `blocked=[]`, keine Warnung. Nur impliziter Server-Owner kann moderieren — gilt als OK. |
| Rolle gelöscht aber DB-Eintrag noch da | `guild.roles.fetch()` liefert null → silent skip. Kein Auto-Cleanup. |
| `channel.permissionsFor(role)` wirft | try/catch um den gesamten collector → `blocked=[]`, kein Warning, Channel-Set läuft. |
| ≥20 blockierte Rollen | Erste 10 + "+X weitere"-Suffix (§5.4) |
| `type === 'mod_log'` | Check wird gar nicht ausgeführt — out-of-scope |
| `tier='supporter'` Rollen | Werden nicht geprüft — `/case` braucht keinen #reports-Zugriff |

### 5.6 Was NICHT geprüft wird
- Member-level Channel-Overrides (zu teuer, false-positives möglich)
- Bot eigene Permissions in `#reports` (das macht der bestehende Check oben)
- `mod_log`-Channel — Stage 2e wenn gewünscht
- `supporter`-Tier-Rollen Permissions

## 6. Testing

### 6.1 Smoke-Tests

**Neu: `tests/smoke/modlog.js`** (offline, kein DB, kein Discord):
- `buildModLogEmbed({action:'warn', caseNumber:1, target, mod, reason:'test'})` → Embed mit Color 0xfaa61a, Title `⚠️ User verwarnt`, 3 fields (User/Moderator/Grund), Footer `Case #1 · 🐾`
- Gleiche call mit `dmFailed:true` → 4 fields (zusätzlich `📬 DM`)
- `action:'timeout', durationMs:60000` → Color 0xfaa61a, Title `⏱️ Timeout vergeben`, 5 fields
- `action:'kick'` → Color 0xed4245, Title `User gekickt`, 3 fields
- `action:'ban'` → Color 0xed4245, Title `🔨 User gebannt`, 3 fields
- `action:'unknown'` → return `null`
- `caseNumber:null` → Footer enthält `Case-Eintrag fehlgeschlagen`

Pattern: Test-Doubles für `target`/`mod` mit `id`/`displayAvatarURL` Stubs. Test ist deterministisch, läuft ohne `--env-file`.

**Ergänzung: `tests/smoke/reports.js`** (bestehender Test):
- Setup: `createReport` → `resolveReport({reportId, modId, caseNumber:42})`
- Aufruf: `getReportByCaseNumber(guildId, 42)` → Row mit korrektem `reporter_id`, `id`
- Aufruf: `getReportByCaseNumber(guildId, 99999)` → `null`
- Cleanup: Test-Reports löschen

### 6.2 Manuelle E2E

**Mod-Log-Refactor** (smoke-Check, dass keine Regression):
- [ ] `/warn @user test` → Mod-Log zeigt `⚠️ User verwarnt`-Embed wie zuvor
- [ ] `/timeout @user 5m test` → Mod-Log zeigt Embed; `User`/`Moderator`-Fields ohne `(username)`-Suffix (bewusste Änderung)
- [ ] `/kick @user test` (owner) → Mod-Log zeigt `User gekickt`-Embed
- [ ] `/ban @user test` (owner) → Mod-Log zeigt `🔨 User gebannt`-Embed
- [ ] `/report @user reason` → claim → resolve → Warn → Mod-Log-Embed wie Stage-2c-E2E

**/case Reverse-Lookup:**
- [ ] `/report` einen User → moderator claimt → resolved mit Warn → Case-Nummer N notieren
- [ ] `/case N` als moderator → Embed zeigt `🚨 Quelle: Report #M von <@reporter>`
- [ ] `/case N` als supporter → gleicher Embed (Anonymität bewusst aufgehoben)
- [ ] `/warn @user direkt` → `/case N+1` → kein Quelle-Field

**Perm-Check:**
- [ ] Neue Mod-Rolle `@TestMod` erstellen, in `#reports` `View Channel` deny
- [ ] `/config role set role:@TestMod tier:moderator`
- [ ] `/config channel set type:report channel:#reports` → Reply enthält Warning mit `<@&TestMod>`
- [ ] `View Channel` auf `@TestMod` allow → `/config channel set type:report channel:#reports` erneut → Reply ohne Warning
- [ ] `/config channel set type:mod_log channel:#mod-log` mit blockierter Rolle → Reply ohne Warning (out-of-scope)
- [ ] Mod-Rolle löschen, `/config channel set type:report` erneut → silent skip, keine Warning, kein Crash

## 7. Rollback

- **Schema:** `INDEX idx_resolution_case` ist additiv. Bei Rollback: alter Code ignoriert den Index, er bleibt im Schema unbenutzt. Kein DROP nötig.
- **`src/modlog.js`:** Bei Rollback Datei löschen + 5 Caller-Imports rückgängig + 4 inline-Builder restoreren. Reine Code-Bewegung.
- **`/case` Reverse-Lookup:** Pure Lese-Operation. Bei Rollback Code-Block aus `case.js` entfernen + `reports.getReportByCaseNumber` aus `module.exports` entfernen. Embed funktioniert ohne.
- **Perm-Check:** Pure Read-Permission-Check. Bei Rollback `collectReportPermWarnings` löschen + Block aus `handleChannelSet` löschen.

Keine Daten-Migration. Volle Reversibilität.

## 8. Open Questions / Future Work

- **Klickbare Verknüpfung im `/case` Quelle-Field:** Mit `message_id` aus dem Report-Row könnte ein Discord-Message-Link gebaut werden (`https://discord.com/channels/<guild>/<reportChan>/<msg>`). Aktuell zeigt das Field nur Text. Stage 2e wenn gewünscht.
- **Perm-Check für `mod_log`:** Gleiche Logik analog, andere Tier-Auswahl (supporter+ statt moderator+). Stage 2e.
- **`postModLog(client, guildId, embed)` Pipeline-Helper:** Fetch+Send+Fail-soft-followUp in `modlog.js` aufnehmen, statt pro Command zu duplizieren. Stage 2e Tech-Debt.
- **Auto-Cleanup orphaned `guild_role_tiers`-Rows:** Wenn eine Discord-Rolle gelöscht wird, bleibt der DB-Eintrag liegen. Aktuell handled fail-soft (silent skip). Stage 3 evtl. mit GuildRoleDelete-Event-Listener.
- **Embed-Layout Configurable per Guild:** Falls Guilds eigene Mod-Log-Styles wollen, müsste `modlog.js` Layout-Slots akzeptieren. YAGNI bis Demand existiert.

## 9. File-Plan-Summary

```
NEU
├── src/modlog.js                                  (~80 LoC)
└── tests/smoke/modlog.js                          (~60 LoC)

GEÄNDERT
├── src/commands/warn.js                           (-30 LoC inline, +5 LoC import+call)
├── src/commands/timeout.js                        (-25 LoC inline, +5 LoC import+call)
├── src/commands/kick.js                           (-15 LoC inline, +5 LoC import+call)
├── src/commands/ban.js                            (-15 LoC inline, +5 LoC import+call)
├── src/interactions/report.js                     (-65 LoC local helper, +3 LoC import+rename)
├── src/commands/case.js                           (+15 LoC Reverse-Lookup block, +1 LoC import)
├── src/reports.js                                 (+14 LoC getReportByCaseNumber + export)
├── src/commands/config.js                         (+30 LoC collector + warning-block)
├── server/schema.sql                              (+5 LoC Stage-2d-Migration-Block)
└── tests/smoke/reports.js                         (+15 LoC getReportByCaseNumber-Test)

ENTFERNT
└── (nichts)
```

Netto-Delta: +135/-150 LoC, also leicht negative LoC. Hauptgewinn: keine duplizierten Mod-Log-Embed-Bauten mehr.
