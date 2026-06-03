# Stage 3 — Escalation Rules Design

**Date:** 2026-06-03
**Status:** Approved (brainstorming session)
**Author:** Lukas (mit Claude Opus 4.7)

---

## 1. Ziel & Scope

**Was Stage 3 baut:** Auto-Eskalation — wenn ein User durch `/warn` die aktive Warn-Anzahl auf eine konfigurierte Schwelle N bringt, führt der Bot automatisch eine Mod-Action aus (`timeout` | `kick` | `ban`) und schreibt einen zweiten Case mit `source='escalation'`, `moderator_id=bot.user.id`.

**Trigger:** AUSSCHLIESSLICH `/warn`. `/timeout`, `/kick`, `/ban`, `/removewarn`, `/reason` triggern keine Eskalation (entweder kein Warn-Count-Change oder kein Increment).

**Threshold-Logik:** Exact-match auf aktive Warn-Anzahl. Rule für Schwelle N feuert wenn nach dem /warn der active count exakt N ist. Rule für 3 feuert bei aktivem Count = 3, nicht bei 4 oder höher.

**Failure-Mode:** Best-effort — der originale /warn-Flow bleibt erfolgreich auch wenn die Eskalation scheitert. Bei Discord-Failure (Permission, höhere Rolle, User-left) wird kein Auto-Case geschrieben, sondern ein Mod-Log-Embed "Auto-Eskalation fehlgeschlagen" gepostet.

**Out-of-Scope:**
- Reverse-Eskalation bei `/removewarn` (kein Rollback bestehender Auto-Cases)
- Per-User-Eskalations-Override / Exempt-Listen (Stage 4 wenn nötig)
- Zeitfenster für Warn-Verfall (Spec §1: nur `active=1` zählt, kein time-decay)
- Tempban (`ban` ist permanent; `duration_minutes` wird bei ban ignoriert)
- Retry-Queue bei Failure (zu komplex für Stage 3)
- Eskalation auf Basis von Timeout-Häufigkeit, Kick-Historie etc.
- Klick-UI fürs Rule-Editing (Slash-Commands reichen)
- `/config escalation toggle` (deaktivieren = unset)
- Rule-History / Audit-Log
- Per-Channel-Rules

## 2. Schema & Architektur

### 2.1 Schema-Migration

Eine ALTER-Statement, idempotent via Stage-2c-Pattern (errno-swallow):

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

`escalation_rules` Tabelle existiert bereits (Stage 1, unbenutzt). Keine weiteren Schema-Änderungen.

### 2.2 Modul-Layout

```
NEU
├── src/escalations.js              ← DAL + apply-Logik
└── tests/smoke/escalations.js      ← Smoke-Test gegen DB

GEÄNDERT
├── server/schema.sql               ← +Migration-Block für source-ENUM
├── src/commands/warn.js            ← +applyEscalation Call nach Mod-Log
├── src/commands/config.js          ← +escalation Subcommand-Group + show-Integration
└── src/cases.js                    ← createCase akzeptiert optionalen `source` Parameter
```

### 2.3 `src/escalations.js` API

```js
// DAL — Rule-CRUD
async function getRuleForThreshold(guildId, threshold)  // → rule oder null
async function listRules(guildId)                       // → rule[] ORDER BY warn_threshold ASC
async function setRule(guildId, threshold, action, durationMinutes)  // UPSERT
async function removeRule(guildId, threshold)           // → affectedRows

// Apply-Logik (kernschritt) — wird aus warn.js aufgerufen
async function applyEscalation({ interaction, target, activeWarnCount })
//   → liest Rule, führt Discord-Action aus, schreibt Case, postet Mod-Log
//   → fail-soft: returns null bei kein Match oder Failure;
//                returns { caseNumber, action } bei Erfolg
```

Modul ist **selbstständig** — kennt Discord (für Action-Calls), DB (für Rule-Lookup + Case-Insert), und ruft sich Module wie `cases.createCase`, `config.getModLogChannelId`, `modlog.buildModLogEmbed` als Dependencies. `warn.js` weiß nichts über Rules, Actions oder Mod-Log-Post.

## 3. Apply-Flow

### 3.1 Where in /warn

Direkt nach dem existierenden Mod-Log-Post-Block (am Ende von `warn.js`-execute). Reihenfolge:

```
1. Validation (tier, target-shape, self/bot-guard)
2. cases.createCase({type: 'warn', source: 'manual', ...}) → caseNumber
3. DM target (best-effort, dmFailed flag setzen)
4. interaction.reply (ephemeral success)
5. Mod-Log-Embed posten (best-effort) — der existierende Warn-Embed
6. ⭐ NEU: const activeWarnCount = await cases.countActiveWarnings(guildId, target.id)
         await escalations.applyEscalation({ interaction, target, activeWarnCount })
```

`activeWarnCount` wird nach Schritt 2 abgefragt, damit der gerade geschriebene Warn mitzählt. `cases.countActiveWarnings` existiert bereits (Stage 1, `src/cases.js:86`).

### 3.2 `applyEscalation` interne Schritte

```
1. Rule-Lookup: rule = getRuleForThreshold(guildId, activeWarnCount)
   → null? → return null (kein Match, normal exit, kein Side-Effect)

2. Compute durationMs (nur wenn rule.action === 'timeout'):
   durationMs = rule.duration_minutes * 60000

3. Discord-Action ausführen — try/catch:
   timeout → member.timeout(durationMs, reason)
   kick    → member.kick(reason)
   ban     → guild.bans.create(target.id, { reason, deleteMessageSeconds: 0 })

   Failure → postFailEmbed(...) → console.warn → return null

4. Case schreiben:
   cases.createCase({
     guildId,
     userId: target.id,
     moderatorId: interaction.client.user.id,  // Bot
     type: rule.action,
     reason: `Auto-Eskalation (Schwelle: ${threshold} aktive Warns)`,
     source: 'escalation',
     durationMs: rule.action === 'timeout' ? durationMs : null,
     expiresAt: rule.action === 'timeout' ? new Date(Date.now() + durationMs) : null,
   })

5. Mod-Log-Embed posten via buildModLogEmbed:
   {
     action: rule.action,
     caseNumber,
     target,  // der User (so wie /warn ihn aus interaction.options.getUser holt)
     mod: interaction.client.user,
     reason: 'Auto-Eskalation (Schwelle: N aktive Warns)',
     durationMs,
   }

Note zu `target`: Der Parameter `target` an `applyEscalation` ist der `User`
(aus `interaction.options.getUser('user')` in warn.js — gleiche Quelle wie warn.js
für seinen eigenen Mod-Log-Embed). Für `member.timeout()` und `member.kick()`
muss `applyEscalation` selbst `await interaction.guild.members.fetch(target.id)`
machen — wenn das null/error wirft → fail-Embed "User nicht im Server". Für
`guild.bans.create(target.id, ...)` reicht die ID (Discord erlaubt Ban-by-ID
auch für nicht-Member).

6. return { caseNumber, action }
```

### 3.3 Discord-Failure-Branch

Wenn `member.timeout()` / `member.kick()` / `guild.bans.create()` wirft (User left guild, Bot fehlt Permission, target hat höhere Rolle, Discord-Outage, etc.):

```js
// Fail-soft mod-log: nur Text-Embed, KEIN Case
const failEmbed = new EmbedBuilder()
  .setTitle('⚠️ Auto-Eskalation fehlgeschlagen')
  .setColor(0xfaa61a)
  .setThumbnail(target.displayAvatarURL({ size: 256 }))
  .addFields(
    { name: '👤 Target', value: `<@${target.id}>`, inline: false },
    { name: '🎯 Geplante Action', value: `${rule.action}${rule.action === 'timeout' ? ` (${formatDuration(durationMs)})` : ''}`, inline: false },
    { name: '🔢 Bei Schwelle', value: `${threshold} aktive Warns`, inline: true },
    { name: '❌ Grund', value: String(err?.message ?? err).slice(0, 900), inline: false },
  )
  .setFooter({ text: '🐾 Oreo' })
  .setTimestamp();
```

Dieser Embed wird in den Mod-Log-Channel gepostet (fail-soft — wenn auch DAS fehlschlägt, nur `console.warn`). Kein Case in DB.

### 3.4 Mod-Log-Embed bei Erfolg

Verwendet `buildModLogEmbed` aus `src/modlog.js` (Stage 2d). Der `reason`-String trägt die Eskalations-Info: `"Auto-Eskalation (Schwelle: 3 aktive Warns)"`.

Beispiel-Embed (action=timeout, threshold=3, duration=30m):
- Title: `⏱️ Timeout vergeben`
- User: `<@target>` / Moderator: `@Oreo` (Bot)
- Grund: `Auto-Eskalation (Schwelle: 3 aktive Warns)`
- Dauer: `30 Minuten` / Läuft ab: `<t:expSec:f>`
- Footer: `Case #N · 🐾`

Im `/case <N>` Mod-View: `Moderator: @Oreo`, `Grund: Auto-Eskalation (...)`, `Quelle: escalation`.

### 3.5 `cases.createCase` Anpassung

`cases.createCase` muss `source` als Parameter akzeptieren. Aktueller impliziter Default ist `'manual'` (per Schema-Default). Stage 3 ergänzt explizit:

```js
async function createCase({
  guildId, userId, moderatorId, type, reason,
  durationMs = null, expiresAt = null, parentCaseNumber = null,
  source = 'manual',  // ← NEW
}) { ... }
```

INSERT-Statement bekommt eine neue Column. Existierende Caller (8 Mod-Commands) sind unverändert — passen `source` nicht mit, Default greift. Nur `escalations.applyEscalation` übergibt `source: 'escalation'`.

## 4. `/config escalation` Subcommand-Group

### 4.1 Slash-Command-Struktur

Erweitert das bestehende `/config`-Command (Stage 2b) um eine 4. Subcommand-Group (neben `role`, `channel`, `feature`):

```
/config escalation set warn_threshold:<N> action:<timeout|kick|ban> [duration:<string>]
/config escalation unset warn_threshold:<N>
/config escalation list
```

**Permissions:** owner-tier (matches `/config role` und `/config channel set type:...`).

### 4.2 `set` Subcommand

**Parameter:**
| Name | Type | Required | Constraints |
|---|---|---|---|
| `warn_threshold` | Integer | yes | `minValue=1, maxValue=100` (slash-builder) |
| `action` | String choice | yes | `timeout` \| `kick` \| `ban` |
| `duration` | String | no | required wenn action=timeout, sonst ignored |

**Validierung-Reihenfolge:**

1. Wenn `action === 'timeout'`:
   - `duration` ist required → fehlend → ❌ "Dauer ist für action:timeout erforderlich. Beispiel: `30m`"
   - `parseDuration(duration)` → wenn null → ❌ "Ungültige Dauer-Angabe"
   - `durationMs < 60_000` (Discord-Minimum 1 Minute) → ❌ "Min. Timeout-Dauer ist 1 Minute"
   - `durationMs > MAX_TIMEOUT_MS` (28 Tage, aus `src/duration.js`) → ❌ "Maximale Timeout-Dauer ist 28 Tage"
   - `durationMinutes = Math.floor(durationMs / 60_000)`
2. Wenn `action === 'kick'` oder `'ban'`:
   - `duration` wenn gesetzt → in reply als Warning notieren: "Dauer wird bei kick/ban ignoriert"
   - `durationMinutes = null`

**DB-Operation:** UPSERT
```sql
INSERT INTO escalation_rules (guild_id, warn_threshold, action, duration_minutes)
VALUES (?, ?, ?, ?)
ON DUPLICATE KEY UPDATE action = VALUES(action), duration_minutes = VALUES(duration_minutes);
```
Schutz durch `UNIQUE KEY uq_threshold_per_guild (guild_id, warn_threshold)`.

**Reply (success):**
```
✅ Eskalation gesetzt: bei 3 aktiven Warns → ⏱️ Timeout 30m
```
Mit Action-Icon Mapping: `timeout: ⏱️`, `kick: 👢`, `ban: 🔨`. Bei kick/ban ohne duration: kein Dauer-Suffix. Mit kick/ban + duration (ignored): `⚠️ Dauer wird bei kick/ban ignoriert` als zweite Zeile.

### 4.3 `unset` Subcommand

**Parameter:** `warn_threshold` (Integer, required, min=1, max=100).

**DB-Operation:**
```sql
DELETE FROM escalation_rules WHERE guild_id = ? AND warn_threshold = ?;
```

**Reply:**
- `affectedRows > 0` → `✅ Eskalation für Schwelle 3 entfernt.`
- `affectedRows === 0` → `Keine Eskalation für Schwelle 3 konfiguriert — nichts zu tun.`

### 4.4 `list` Subcommand

**DB-Operation:**
```sql
SELECT warn_threshold, action, duration_minutes
  FROM escalation_rules
 WHERE guild_id = ?
 ORDER BY warn_threshold ASC;
```

**Reply** (Embed):
- Title: `🎯 Eskalations-Regeln`
- Color: `0x5865f2` (matches /config show)
- Empty state: Description = `Keine Eskalations-Regeln konfiguriert. Setze welche mit /config escalation set.`
- Mit Rules: jede Regel als Bullet-Line im Description-Block, kompakt:
  ```
  • Schwelle 3 → ⏱️ Timeout 30 Minuten
  • Schwelle 5 → 👢 Kick
  • Schwelle 10 → 🔨 Ban
  ```
- Footer: `🐾 Oreo`

Duration-Display: `formatDuration(durationMinutes * 60_000)` aus `src/duration.js`.

### 4.5 Integration in `/config show`

Das bestehende `/config show` Embed bekommt eine neue Section. Position: zwischen "Features" und "Stats".

**Field-Name:** `🎯 Eskalation` (inline=false)
**Field-Value:**
- Keine Rules: `keine Regeln gesetzt`
- Mit Rules: Bullet-Liste wie §4.4, getrennt durch Newlines

Wenn ≥10 Rules existieren: erste 5 + `... +N weitere` (analog Stage 2d `MAX_ROLES_IN_PERM_WARNING`). Spec-internal threshold: `MAX_ESCALATION_RULES_IN_SHOW = 5`.

## 5. Edge-Cases & Failure-Modes

### 5.1 Discord-Failure-Tabelle

| Failure | Ursache | Verhalten |
|---|---|---|
| `member` ist null nach `guild.members.fetch` | User hat Guild verlassen (für timeout/kick) | Skip Action, fail-Embed mit Grund "User nicht (mehr) im Server" |
| Bot fehlt `ModerateMembers` | Permission-Issue | Skip, fail-Embed mit Grund "Bot fehlt ModerateMembers" |
| Bot fehlt `KickMembers`/`BanMembers` | Permission-Issue | Skip, fail-Embed mit Hint |
| Target hat höhere Rolle als Bot | Role-Hierarchy | Skip, fail-Embed mit Grund "Target hat höhere oder gleiche Rolle wie Bot" |
| Discord error 50013 (missing permissions) | misc | Skip, fail-Embed mit code + message |
| Discord rate-limit | mass-warn-events | discord.js queued internally — kein Eingriff |
| `cases.createCase` wirft (DB-Fehler) | DB-issue | Discord-Action ist schon durch — console.error + fail-Embed "Case-Schreibung fehlgeschlagen (Discord-Action durchgeführt)". State drift, manual cleanup nötig. |
| `buildModLogEmbed` wirft (unwahrscheinlich) | Bug | console.error, kein User-facing Failure |

### 5.2 Race-Conditions

| Szenario | Verhalten |
|---|---|
| 2 Mods /warnen gleichzeitig denselben User | Beide Warns kriegen separate Cases (LAST_INSERT_ID-Pattern, atomic). Jeder /warn ruft sein eigenes `countActiveWarnings` nach dem Insert — beide könnten denselben count sehen wenn extrem concurrent. Maximal: Rule für N feuert zweimal in Folge → 2 Auto-Cases. Akzeptabel, im Mod-Log sichtbar. |
| /warn + /removewarn race | Standard MySQL-Isolation (REPEATABLE READ in InnoDB). `countActiveWarnings` nach dem Warn-Insert sieht den eigenen Insert. Removewarn-effect first reads the version-snapshot. Beide räumen unabhängig — keine spezielle Handhabung. |
| /removewarn entfernt einen Warn der bereits eskaliert hat | Auto-Case bleibt bestehen (nicht reverted). Active count sinkt. Nächster /warn der den count wieder auf N bringt → triggert N-Rule erneut (Spec §1). |

### 5.3 Self-Escalation-Schutz

Was wenn ein Mod sich selbst /warnt und Schwelle erreicht?
- Bot Tries auto-action. Wenn Mod höhere Rolle hat als Bot → fail-Embed (siehe §5.1).
- Wenn Bot success könnte: Mod wird tatsächlich getimeoutet/gekickt/gebannt.
- **Kein expliziter "Mod-exempt"-Check** — out-of-scope für Stage 3. Die /warn-Pipeline hat schon einen Tier-Check (warner muss ≥ target im Rang sein), aber das verhindert nicht eine Self-Warn-Loop. Akzeptabel — Mods wissen was sie tun.

### 5.4 Bot-User als Target

`/warn` hat schon einen Bot-guard ("Bots können nicht gewarnt werden"). Eskalation kann nicht passieren, weil der Warn nie geschrieben wird.

### 5.5 Schwellen-Wertebereich

- Min: 1 (theoretisch — bei erstem /warn eskaliert)
- Max: 100 (oberhalb davon kein praktischer Use-Case)
- Slash-builder enforced via `setMinValue(1).setMaxValue(100)` auf der Integer-Option

### 5.6 Duration-Handling

Reuse `src/duration.js` `parseDuration(input)` aus Stage 2c:
- Input-Formats: `30m`, `2h`, `7d`, `1w` → ms
- DB-Storage: `duration_minutes INT UNSIGNED` (Schema)
- Conversion in `/config escalation set`: `Math.floor(parseDurationMs / 60_000)`
- Conversion in `applyEscalation`: `rule.duration_minutes * 60_000` → ms
- Min: 60_000 ms (Discord-Limit, 1 Minute)
- Max: `MAX_TIMEOUT_MS` = 28 Tage = 2_419_200_000 ms = 40320 Minuten

Edge-Cases:
- `duration:45s` → parseDuration: 45000ms → 45000/60000 = 0.75 → `Math.floor` = 0 → block via min-check vor floor
- `duration:30t` → parseDuration: 30 Tage → > MAX_TIMEOUT_MS → block

## 6. Testing-Strategie

### 6.1 Smoke-Test: `tests/smoke/escalations.js`

DB-basiert (analog `tests/smoke/reports.js`):

```js
// 1. setRule + getRuleForThreshold roundtrip
// 2. setRule UPSERT (overwrite existing threshold)
// 3. listRules sortiert nach threshold ASC
// 4. removeRule returns affectedRows
// 5. getRuleForThreshold liefert null bei unbekannter Schwelle
// Cleanup: DELETE all rules WHERE guild_id = TEST_GUILD
```

5 Test-Blöcke, identisches Format wie der bestehende reports-Test. Smoke-Test deckt nur die DAL ab; `applyEscalation` wird nicht gestestet (Discord-Side-Effects, landet in manuellem E2E).

### 6.2 Manuelle E2E in Discord

**Setup:**
- Test-Guild mit zwei Test-Accounts: `@target` (regular member), `@warner` (moderator-tier)
- Owner-Account für /config escalation
- Bot hat `ModerateMembers`, `KickMembers`, `BanMembers` Permissions
- Mod-Log + Report-Channel konfiguriert (Stage 2b/c)

**Konfiguration-Tests:**
- [ ] **K1** `/config escalation set warn_threshold:3 action:timeout duration:30m` → ✅ Reply mit threshold + action
- [ ] **K2** `/config escalation list` → Embed zeigt nur Schwelle 3 mit "30 Minuten"
- [ ] **K3** `/config escalation set warn_threshold:3 action:kick` (UPSERT) → ✅ Reply
- [ ] **K4** `/config escalation list` → Schwelle 3 jetzt mit kick
- [ ] **K5** `/config escalation set warn_threshold:5 action:timeout duration:garbage` → ❌ "Ungültige Dauer"
- [ ] **K6** `/config escalation set warn_threshold:5 action:timeout duration:30t` → ❌ "Max. 28 Tage"
- [ ] **K7** `/config escalation set warn_threshold:5 action:timeout` (no duration) → ❌ "Dauer erforderlich"
- [ ] **K8** `/config escalation set warn_threshold:5 action:kick duration:30m` → ✅ + "Dauer ignoriert"-Warning, list zeigt kick ohne duration
- [ ] **K9** `/config escalation unset warn_threshold:5` → ✅ "entfernt"
- [ ] **K10** `/config escalation unset warn_threshold:999` → "Keine Eskalation — nichts zu tun"
- [ ] **K11** `/config show` → enthält "🎯 Eskalation"-Section mit Schwelle 3
- [ ] **K12** Supporter-Account versucht `/config escalation set ...` → ❌ Permission-Denied

**Auto-Eskalations-Tests** (Setup: Schwelle 3 → timeout 5m):
- [ ] **E1** `/warn @target Grund1` → Case, kein Auto-Action (Schwelle 1, keine Rule)
- [ ] **E2** `/warn @target Grund2` → Case, kein Auto-Action (Schwelle 2, keine Rule)
- [ ] **E3** `/warn @target Grund3` → **2 Embeds im Mod-Log:** (a) normaler Warn, (b) Auto-Timeout mit `Moderator: @Oreo`, `Grund: Auto-Eskalation (Schwelle: 3 aktive Warns)`. Target ist getimeoutet für 5m.
- [ ] **E4** `/case <Auto-Case-N>` → zeigt `Quelle: escalation`, `Moderator: @Oreo`
- [ ] **E5** `/warn @target Grund4` → Case, kein Auto-Action (count=4, keine Rule für 4)
- [ ] **E6** `/removewarn <Warn1-Case>` → count sinkt 4 → 3, **kein** Auto-Action (Decrement triggert keine Rule)
- [ ] **E7** `/removewarn <Warn2-Case>` → count sinkt 3 → 2, **kein** Auto-Action
- [ ] **E7b** `/warn @target Grund5` → count steigt 2 → 3 → Auto-Timeout-Embed feuert ERNEUT (Re-Fire der 3er-Rule per Spec §1 exact-match)

**Failure-Tests:**
- [ ] **F1** Bot `ModerateMembers` entziehen, Schwelle 3 mit timeout. `/warn @target` zu count 3 → "⚠️ Auto-Eskalation fehlgeschlagen" Embed (Grund nennt Permission), **kein** Auto-Case
- [ ] **F2** Target verlässt Server, dann (irgendwie) count auf 3 — fail-Embed "User nicht (mehr) im Server"
- [ ] **F3** Rule mit action=ban, target hat höhere Rolle als Bot → fail-Embed "Target hat höhere Rolle"

**Out-of-Scope-Verifikation:**
- [ ] **X1** `/timeout @target 1h test` → **kein** Eskalations-Trigger (Mod-Action zählt nicht als Warn)
- [ ] **X2** `/removewarn <case>` bringt count von 3 auf 2 → kein Eskalations-Rollback (Auto-Case bleibt aktiv)
- [ ] **X3** `/reason <case>` editieren → kein Trigger
- [ ] **X4** Mod gibt sich selbst /warn bis Schwelle 3 → fail-Embed "höhere Rolle" (Bot kann Mod nicht ranklassen, kein Self-Escalate)

### 6.3 Rollback

- **Schema:** ENUM-Erweiterung ist additiv. Bei Rollback: alter Code ignoriert 'escalation'-Rows. `/case` würde "Quelle: escalation" zeigen statt "manual" — kosmetisch.
- **`src/escalations.js`:** Datei löschen + `applyEscalation`-Call in `warn.js` entfernen + `source`-Parameter in `cases.createCase` entfernen. `escalation_rules`-Rows bleiben (FK-cascade nur bei guild-delete).
- **`/config escalation`-Subcommand-Group:** löschen, slash-redeploy.
- **`/config show` Eskalations-Section:** löschen.

Volle Reversibilität wenn die Stage-3-Commits zusammenhängen.

## 7. Open Questions / Future Work

- **Per-User-Exempt:** "@TrialMods sind von Eskalation ausgenommen" — Stage 3e wenn nötig (`escalation_exemptions` Tabelle analog `automod_exemptions`)
- **Soft-Delete für /removewarn:** statt `active=0` setzen, Reset-Flag pro Rule "feuere nicht wenn vorher schon eskaliert wurde" — Stage 3f
- **Tempban:** action='tempban' mit duration_minutes — würde Discord-API-Wrapper für scheduled-unban brauchen (cron). Stage 5
- **Mehrere Actions pro Rule:** "bei 3 Warns → DM warn + timeout" — Stage 3g
- **Eskalation auf Basis von /timeout-Count:** häufige Timeouts → automatischer Ban — Stage 5
- **Threshold-Vorschau:** /config escalation preview user:@X — simuliert was bei nächstem /warn passieren würde — Stage 3h
- **Bot-User-Permissions-Check im set-Command:** warnen wenn `/config escalation set action:ban` aber Bot fehlt BanMembers Permission — Stage 3i

## 8. File-Plan-Summary

```
NEU
├── src/escalations.js                              (~150 LoC)
└── tests/smoke/escalations.js                      (~70 LoC)

GEÄNDERT
├── server/schema.sql                               (+5 LoC ALTER block)
├── src/cases.js                                    (+1 Parameter + +1 SQL-Column)
├── src/commands/warn.js                            (+3 LoC import + +2 LoC apply-call)
└── src/commands/config.js                          (+~120 LoC subcommand-group + handlers + show-integration)
```

Netto-Delta: ca. +350 LoC, ein neues Modul + ein neuer Test. Stage 3 ist ungefähr halb so groß wie Stage 2c (Reports) und groß wie Stage 2d (deferred items).
