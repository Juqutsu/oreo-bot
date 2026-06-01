# Stage 2c — Report-System Design

**Datum:** 2026-06-01
**Status:** Approved
**Stage:** 2c (folgt auf 2b config-channels)

## 1. Ziel

Ein User-facing Report-System für Oreo:
- User können andere User via `/report user:<…> reason:<text> [evidence_url:<url>]` melden.
- Reports landen als interaktiver Embed im konfigurierten `report_channel` (aus Stage 2b).
- Moderatoren bearbeiten Reports per Button (Übernehmen / Resolve / Verwerfen).
- Resolve kann eine konkrete Infraction-Action auslösen (warn/timeout/kick/ban) ODER „None" (Report als „kein Versto" abgeschlossen).
- Wenn eine Infraction erstellt wird, ist die Verknüpfung Report ↔ Case bidirektional rekonstruierbar (über die neue Spalte `reports.resolution_case_number`).
- Anonymität: der gemeldete User erfährt nie, wer ihn gemeldet hat.

Stage 2c führt erstmals **Discord-Component-Interactions** (Buttons, String-Selects, Modals) im Projekt ein. Damit verbunden ist ein neuer Dispatcher-Pfad in `index.js`.

## 2. Out-of-Scope (für Stage 2c)

- `/case <N>` zeigt den verlinkten Report nicht an. Reverse-Lookup folgt später.
- Kein `/report list` oder `/report show <id>` Command — Reports werden ausschließlich über den Embed im `report_channel` verwaltet. Re-post-bei-gelöschter-Embed-Message: out-of-scope.
- Reports werden nicht über das Mod-Log dupliziert.
- Keine Eskalations-Regeln (Stage 3).
- Keine Automod-Integration (Stage 4).
- Keine Pagination, kein Bulk-Resolve, kein Re-Open.

## 3. Architektur

```
src/commands/report.js     # Slash command: signature + execute
src/reports.js             # DB service module + cooldown map
src/interactions/report.js # Button/Select/Modal handler + dispatcher
index.js                   # InteractionCreate erweitert um component path
server/schema.sql          # ALTER reports + neue INDEX
src/schema.js              # Loader fängt ER_DUP_FIELDNAME/ER_DUP_KEYNAME ab
```

Das spiegelt das existierende Pattern (`cases.js`/`perms.js`/`config.js` als Service-Module, `commands/<name>.js` als Slash-Wrapper). Stage 2c **etabliert** das `src/interactions/`-Verzeichnis erstmalig — zukünftige Stages mit Component-Interaktionen folgen demselben Layout.

### 3.1 customId-Schema

Alle Component-customIds beginnen mit dem Feature-Präfix `report:` für den Dispatcher.

```
report:claim:<reportId>                       # Button: Übernehmen
report:resolve:<reportId>                     # Button: Resolve → ephemeral select
report:dismiss:<reportId>                     # Button: Verwerfen → modal
report:action-select:<reportId>               # StringSelect der Action
report:modal-resolve:<reportId>:<action>      # Modal-Submit für Resolve
report:modal-dismiss:<reportId>               # Modal-Submit für Verwerfen
```

`<action>` ∈ `{none, warn, timeout, kick, ban}`.

### 3.2 Dispatcher in `index.js`

```js
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) { /* existing path bleibt unverändert */ return; }

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

`reportInteractions.dispatch(interaction)` returnt `true`, wenn der customId mit `report:` beginnt und der Handler gelaufen ist, sonst `false`. Das Pattern bleibt offen für zukünftige Feature-Module (z.B. `escalationInteractions.dispatch`) als Liste durchprobierter Dispatcher.

## 4. Datenmodell

### 4.1 Bestehende `reports`-Tabelle (Stage 1)

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
```

### 4.2 Migration (Stage 2c)

```sql
ALTER TABLE reports
  ADD COLUMN resolution_case_number INT UNSIGNED NULL,
  ADD COLUMN message_id BIGINT UNSIGNED NULL,
  ADD INDEX idx_dup_check (guild_id, reporter_id, reported_user_id, status);
```

`src/schema.js` muss die ALTERs idempotent ausführen: ER_DUP_FIELDNAME (1060) und ER_DUP_KEYNAME (1061) catch — gleiches Pattern wie Stage 1.5 (siehe `infractions`-ALTER-Geschichte, MySQL 8.x kann `IF NOT EXISTS` nicht).

### 4.3 Status-Maschine

```
open ───── Übernehmen ──▶ investigating
   │           │
   │           ▼
   ▼      Verwerfen ────────▶ dismissed
Verwerfen                          │
   │                               │
   ▼                               │
dismissed                          │
                                   │
   open ─── Resolve+Action ──▶ resolved
              (Modal-Submit)       │
   investigating ──────────────────┘
```

- `open` — frisch, niemand hat geklickt
- `investigating` — Übernehmen geklickt, `assigned_mod_id` gesetzt
- `resolved` — Resolve abgeschlossen. Wenn Action ≠ None: `resolution_case_number` gesetzt
- `dismissed` — Verwerfen abgeschlossen

`resolved_at` wird beim Übergang in `resolved` ODER `dismissed` gesetzt.
`resolution_note` ist NULL bei `open`/`investigating`, optional bei `resolved`/`dismissed`.

### 4.4 Felder, die NICHT verwendet werden

- Kein FK auf `infractions(guild_id, case_number)` — Application-Side-Lookup. Begründung: `infractions` löscht nichts (deactivate ist nur ein Flag), der Link bleibt stabil.
- Kein `escalation_rules`-Bezug. Stage 3.

## 5. `/report` Slash Command

### 5.1 Signatur

```js
new SlashCommandBuilder()
  .setName('report')
  .setDescription('Meldet einen User an die Moderation.')
  .setDMPermission(false)
  .addUserOption(o => o
    .setName('user')
    .setDescription('Wer soll gemeldet werden?')
    .setRequired(true))
  .addStringOption(o => o
    .setName('reason')
    .setDescription('Was ist passiert? (max 500 Zeichen)')
    .setRequired(true)
    .setMaxLength(500))
  .addStringOption(o => o
    .setName('evidence_url')
    .setDescription('Optional: Link zu Screenshot oder Nachricht')
    .setRequired(false)
    .setMaxLength(500));
```

**Kein `requiredTier`-Feld.** Der Command-Loader (`src/loadCommands.js`) skippt den Tier-Check wenn `requiredTier` fehlt — analog zu `/setup`. Damit ist `/report` für jeden Member zugänglich.

### 5.2 Execute-Flow

```
1. Pre-Validation (in dieser Reihenfolge, jeweils ephemeral fail):
   a) channelId = config.getReportChannelId(guildId)
      → wenn null: "Report-System ist nicht aktiv.
         Bitte ein Admin: `/config channel set type:report channel:#...`"
   b) target.id === interaction.user.id
      → "Du kannst dich nicht selbst melden."
   c) target.bot === true
      → "Bots können nicht gemeldet werden."
   d) await guild.members.fetch(target.id).catch(() => null)
      → wenn null: "User ist nicht (mehr) auf dem Server."

2. Cooldown-Check (in-memory Map):
   const remainingMs = reports.checkCooldown(reporterId)
   → wenn > 0: "Bitte warte noch <Math.ceil(remainingMs/1000)>s vor dem nächsten Report."

3. Duplicate-Check:
   const isDup = await reports.hasOpenReportFromTo(guildId, reporterId, targetId)
   → wenn true: "Du hast bereits einen offenen Report gegen diesen User."

4. evidenceUrl?.startsWith('http://') || evidenceUrl?.startsWith('https://')
   → wenn String gesetzt aber nicht URL: "Evidence muss mit http:// oder https:// beginnen."
   (kein deeper validate — YAGNI)

5. INSERT INTO reports (...) → reportId via LAST_INSERT_ID() (MySQL hat kein RETURNING)
6. Build Embed (siehe Sektion 6) + ActionRow [Übernehmen, Resolve, Verwerfen]
   const channel = await guild.channels.fetch(channelId)
   const msg = await channel.send({ embeds, components })
   await reports.attachMessageId(reportId, msg.id)

   Falls send wirft (Bot ohne Permission im report_channel):
   → ephemeral fail an Reporter:
     "Der Bot kann nicht in den Report-Channel posten. Bitte Admin informieren."
   → status bleibt 'open', message_id NULL.
   Re-Post-Workflow ist out-of-scope (siehe §2).

7. reports.touchCooldown(reporterId)
8. interaction.reply({ content: '✅ Report #<id> eingereicht. Die Moderation wird sich kümmern.', flags: MessageFlags.Ephemeral })
```

### 5.3 Cooldown-Implementierung

In `src/reports.js`:

```js
const COOLDOWN_MS = 60_000;
const cooldown = new Map(); // userId (string) → epoch ms

function checkCooldown(userId) {
  const last = cooldown.get(userId);
  if (!last) return 0;
  const remaining = COOLDOWN_MS - (Date.now() - last);
  return remaining > 0 ? remaining : 0;
}

function touchCooldown(userId) {
  cooldown.set(userId, Date.now());
}
```

In-memory. Verloren bei Bot-Restart — akzeptabel für ein 60s-Fenster.
Pro Reporter ist der Cooldown global über Guilds hinweg — das Anti-Spam-Ziel ist bot-weit.

### 5.4 Duplicate-Check

```sql
SELECT 1 FROM reports
 WHERE guild_id = ? AND reporter_id = ? AND reported_user_id = ?
   AND status IN ('open','investigating')
 LIMIT 1
```

Index `idx_dup_check` macht das zum Index-Lookup. Scope ist per-guild — derselbe Reporter kann denselben User in zwei verschiedenen Guilds parallel reporten.

## 6. Embed-Layout

### 6.1 Initial (Status `open`)

```
┌────────────────────────────────────────────┐
│ 🆕 Report #42                              │  ← title, color 0xFEE75C (gelb)
│                                            │
│ Gemeldeter User: @bad (123456789)          │  ← inline field
│ Reporter:        @alice (987654321)        │  ← inline field
│                                            │
│ Grund                                      │
│ "Schreibt seit 10 Min nur Slurs in #gen."  │
│                                            │
│ Evidence: [Link](https://...)              │  ← nur wenn evidence_url
│                                            │
│ Status: 🟡 Offen                           │  ← inline field
│ Eingegangen: <t:1780000000:R>              │  ← inline field
└────────────────────────────────────────────┘
[Übernehmen]  [Resolve]  [Verwerfen]
```

Reporter-Mention erscheint **nur** im Report-Channel-Embed.

### 6.2 Farben

| Status | Hex | Farbe |
|---|---|---|
| open | `0xFEE75C` | gelb |
| investigating | `0x5865F2` | blurple |
| resolved (Action ≠ None) | `0x57F287` | grün |
| resolved (None) | `0x95A5A6` | grau |
| dismissed | `0xED4245` | rot |

### 6.3 State-Transitions (Message-Edit)

**open → investigating:**
- Color: blurple
- Status field: `🔵 In Bearbeitung von <@modId>`
- Buttons: `[Resolve] [Verwerfen]` (Übernehmen entfernt)

**open|investigating → resolved (Action ≠ None):**
- Color: grün
- Status field: `✅ Resolved von <@modId> → <action> (Case #<caseNumber>)`
- Footer: `<resolution_note>` falls vorhanden
- Buttons: alle entfernt (`components: []`)

**open|investigating → resolved (Action = None):**
- Color: grau
- Status field: `✅ Resolved von <@modId> → Keine Action`
- Footer: `<resolution_note>` falls vorhanden
- Buttons: entfernt

**open|investigating → dismissed:**
- Color: rot
- Status field: `🚫 Verworfen von <@modId>`
- Footer: `<resolution_note>` falls vorhanden
- Buttons: entfernt

### 6.4 Edit-Mechanismus

```js
async function editReportMessage(guild, channelId, report, newState) {
  if (!report.message_id) return false; // kein Embed da — fail-soft
  try {
    const channel = await guild.channels.fetch(channelId);
    const msg    = await channel.messages.fetch(report.message_id);
    await msg.edit({ embeds: [newState.embed], components: newState.components });
    return true;
  } catch (e) {
    console.warn(`[reports] cannot edit report message ${report.message_id}`, e?.code || e);
    return false; // Caller entscheidet, ob ephemeraler Hinweis nötig
  }
}
```

Wenn die Message zwischenzeitlich gelöscht wurde → DB-State bleibt korrekt, der Mod kriegt einen ephemeren Hinweis „Report-Message wurde gelöscht — Status wurde trotzdem aktualisiert."

### 6.5 Anonymität

Der **gemeldete User** sieht den Reporter **nirgendwo**:
- Nicht im DM (es gibt keine).
- Nicht im Mod-Log-Embed der Infraction (Stage 1 `cases.js` postet ein Embed mit `moderator` = der Resolver, nicht der Reporter).
- Nicht im `/case <N>`-Output (Stage 1 `cases.js` zeigt nur `moderator`).

Der **Reporter** ist nur im Report-Channel-Embed sichtbar, der für `moderator+`-Tier konfiguriert sein sollte (zukünftige Stage 2d könnte Channel-Permissions automatisch prüfen — out-of-scope).

## 7. Interaction-Handler

Alle Handler in `src/interactions/report.js`.

### 7.1 `handleClaim` (Übernehmen-Button)

```
- if (!await perms.requireTier(interaction, 'moderator')) return true
- BEGIN TRANSACTION
- SELECT report FOR UPDATE → fail wenn !exists oder status NOT IN ('open','investigating')
  → ephemeral "Report existiert nicht oder ist bereits abgeschlossen."
- UPDATE reports SET status='investigating', assigned_mod_id=? WHERE id=?
- COMMIT
- editReportMessage(report, claimedState)
- reply ephemeral "Du übernimmst Report #<id>."
```

Re-Claim durch denselben Mod auf already-investigating: idempotent no-op mit `"Du hast Report #<id> bereits übernommen."`. Re-Claim durch anderen Mod: erlaubt, Embed wird auf neuen Mod aktualisiert.

### 7.2 `handleResolveOpenSelect` (Resolve-Button)

```
- if (!await perms.requireTier(interaction, 'moderator')) return true
- SELECT report → fail wenn status NOT IN ('open','investigating')
  → ephemeral "Report ist bereits abgeschlossen."
- Baue StringSelectMenu (customId: report:action-select:<reportId>):
    Optionen (mit Emoji):
      ✅ None     — "Report ohne Action abschließen"
      ⚠️ Warn     — "Verwarnung aussprechen"
      ⏱️ Timeout  — "User timeout-en"
      👢 Kick     — "User kicken"
      🔨 Ban      — "User bannen"
- interaction.reply({ content: 'Aktion wählen:', components: [actionRow], flags: MessageFlags.Ephemeral })
```

### 7.3 `handleActionSelect` (String-Select-Submit)

```
- action = interaction.values[0]   // 'none' | 'warn' | 'timeout' | 'kick' | 'ban'
- Per-Action-Tier-Check:
    if (action === 'kick' || action === 'ban') requiredActionTier = 'owner'
    else requiredActionTier = 'moderator'
  if (!await perms.hasTier(interaction.member, requiredActionTier)) {
    return interaction.update({
      content: `Aktion **${action}** benötigt **${requiredActionTier}**-Tier.`,
      components: []
    })
  }
- Baue action-spezifisches Modal (customId: report:modal-resolve:<reportId>:<action>):
    none    → [resolution_note (paragraph, optional, max 500)]
    warn    → [reason (paragraph, required, max 500)]
    timeout → [duration (short, required, default '60m', max 16),
               reason (paragraph, required, max 500)]
    kick    → [reason (paragraph, required, max 500)]
    ban     → [reason (paragraph, required, max 500)]
- interaction.showModal(modal)
```

### 7.4 `handleModalResolve` (Resolve-Modal-Submit)

```
- action aus customId, fields aus interaction.fields
- BEGIN TRANSACTION
  - SELECT report FOR UPDATE
    → fail wenn status NOT IN ('open','investigating')
       (Race mit anderem Mod, der zwischenzeitlich resolved hat)
       → ephemeral "Report wurde inzwischen von einem anderen Mod bearbeitet."
       → ROLLBACK, return
  - Falls action !== 'none':
    - Bei timeout: durationMs = parseDuration(fields.duration)
      → wenn null: ephemeral fail "Ungültige Dauer. Nutze z.B. 30s, 10m, 2h, 1t, 1w." → ROLLBACK, return
      → wenn durationMs > MAX_TIMEOUT_MS (28d, identisch mit existierendem /timeout): ephemeral fail "Maximale Timeout-Dauer ist 28 Tage." → ROLLBACK, return
      → Re-Use: `parseDuration` und `MAX_TIMEOUT_MS` aus `src/commands/timeout.js` exportieren oder als geteilten Helper in `src/duration.js` extrahieren (Empfehlung: extrahieren, da auch Resolve-Pfad denselben Code braucht)
    - target = await guild.members.fetch(reported_user_id).catch(null)
      Bei kick/timeout: target muss existieren → ephemeral fail wenn null → ROLLBACK, return
      Bei warn/ban: target.fetch optional, ban geht auch ohne member-presence
    - Discord-Action ausführen:
        warn    → kein Discord-API-Call, nur DB
        timeout → targetMember.timeout(durationMs, `${mod.user.tag}: ${reason}`)
        kick    → targetMember.kick(`${mod.user.tag}: ${reason}`)
        ban     → guild.bans.create(reported_user_id, { reason: `${mod.user.tag}: ${reason}` })
      → wenn Discord-API wirft: ephemeral fail "Konnte Aktion nicht ausführen: <err>" → ROLLBACK, return
    - caseNumber = await cases.createCase({
        guildId, type: action, userId: reported_user_id,
        moderatorId: mod.id, reason, durationMs (nur bei timeout), expiresAt (nur bei timeout)
      })   // läuft in eigener Transaction von cases.js
  - UPDATE reports
      SET status='resolved', assigned_mod_id=?, resolved_at=NOW(),
          resolution_note=?,
          resolution_case_number=?   -- NULL bei action='none'
      WHERE id=?
- COMMIT
- editReportMessage(report, resolvedState)
- Falls action !== 'none': postModLogEmbed(action, target, mod, reason, caseNumber)
  (Pattern aus src/commands/warn.js dupliziert — siehe §7.6)
- reply ephemeral:
    none → "Report #<id> als ohne Action abgeschlossen."
    sonst → "Report #<id> als <action> resolved (Case #<caseNumber>)."
```

### 7.5 `handleDismissOpenModal` + `handleModalDismiss`

```
handleDismissOpenModal:
- requireTier moderator
- SELECT report → fail wenn nicht open/investigating
- Modal (customId: report:modal-dismiss:<reportId>):
    [resolution_note (paragraph, optional, max 500, placeholder: 'Doppel-Report, kein Verstoß, …')]
- showModal

handleModalDismiss:
- BEGIN TRANSACTION
- SELECT FOR UPDATE → race-check
- UPDATE reports SET status='dismissed', resolved_at=NOW(),
                     assigned_mod_id=?, resolution_note=?
- COMMIT
- editReportMessage(report, dismissedState)
- reply ephemeral "Report #<id> verworfen."
```

### 7.6 Mod-Log-Embed-Posting

Wenn `handleModalResolve` einen Case erstellt, muss das Mod-Log-Embed gepostet werden — analog zu jedem bestehenden Mod-Command. Wir **duplizieren** das Pattern aus `src/commands/warn.js` (bzw. dem entsprechenden Command pro Action-Type) ins Resolve-Handler. Konkret:

```js
const modLogChannelId = await config.getModLogChannelId(guildId);
if (modLogChannelId) {
  const modLogChannel = await guild.channels.fetch(modLogChannelId).catch(() => null);
  if (modLogChannel) {
    await modLogChannel.send({
      embeds: [buildModLogEmbed(action, target, mod, reason, caseNumber, durationMs)]
    }).catch(e => console.warn('[reports] modlog send failed', e?.code || e));
  }
}
```

**Fail-soft:** Mod-Log-Send-Fehler blockt den Resolve nicht. DB-State und Report-Embed-Edit sind bereits committed. Identisches Pattern wie Stage 2b Mod-Command-Migration.

Refactoring der duplizierten Mod-Log-Logik in einen gemeinsamen Helper ist scope-creep und gehört in Stage 2d (Tech-Debt-Pass) oder später.

## 8. `src/reports.js` API

```js
const COOLDOWN_MS = 60_000;
const cooldown = new Map();

exports.createReport({ guildId, reporterId, reportedUserId, reason, evidenceUrl }) → Promise<reportId>
exports.attachMessageId(reportId, messageId) → Promise<void>
exports.getReport(reportId, { forUpdate = false, conn = null }) → Promise<row|null>
exports.hasOpenReportFromTo(guildId, reporterId, reportedUserId) → Promise<boolean>
exports.claimReport(reportId, modId) → Promise<{updated, alreadyClaimedBy}>
exports.resolveReport(reportId, { modId, note, caseNumber, conn }) → Promise<void>
exports.dismissReport(reportId, { modId, note, conn }) → Promise<void>
exports.checkCooldown(userId) → number  // remaining ms, 0 wenn frei
exports.touchCooldown(userId) → void
```

Alle DB-Funktionen nehmen optional `conn` an, damit der Caller in seiner eigenen Transaction arbeiten kann (`SELECT FOR UPDATE` + `UPDATE` in einem Batch).

`createReport` ist eine simple INSERT ohne Transaction. `claimReport`, `resolveReport`, `dismissReport` müssen vom Caller in einer Transaction mit vorhergehendem `SELECT FOR UPDATE` aufgerufen werden.

## 9. Error-Handling-Strategie

Konsistent mit Stage 2b:

| Failure | Strategie |
|---|---|
| Report-Channel nicht konfiguriert | Reporter-ephemeraler Hinweis + exakter `/config`-Befehl |
| Bot kann nicht in Report-Channel posten | Reporter-ephemeraler Fehler, DB-Insert bleibt (message_id NULL) |
| Report-Embed-Message gelöscht | Mod-ephemeraler Hinweis, DB-Status wird trotzdem aktualisiert |
| Race-Condition (zwei Mods gleichzeitig) | `SELECT FOR UPDATE` in Transaction; zweiter Mod kriegt ephemeralen Fehler |
| Mod-Log-Channel nicht konfiguriert / unreachable | Resolve läuft durch, nur `console.warn` |
| Discord-API wirft beim timeout/kick/ban | Ephemeraler Fehler an Mod, ROLLBACK, kein Case, Report bleibt offen |
| `cases.createCase` wirft | Ephemeraler Fehler, ROLLBACK, Report bleibt offen |
| Cooldown aktiv | Ephemeraler Hinweis mit verbleibenden Sekunden |
| Duplicate (open Report von dems. Reporter gegen dens. Target) | Ephemeraler Hinweis |

## 10. Testing

### 10.1 Smoke-Test-Skript (analog Stage 2b `tests/smoke/config.js`)

`tests/smoke/reports.js`:
- createReport → row vorhanden, status='open'
- hasOpenReportFromTo gibt true
- claimReport → status='investigating', assigned_mod_id gesetzt
- resolveReport mit caseNumber → status='resolved', resolution_case_number gesetzt
- resolveReport mit null caseNumber (None-Pfad) → status='resolved', resolution_case_number NULL
- dismissReport → status='dismissed', resolution_note gesetzt
- checkCooldown direkt nach touchCooldown → > 0; nach 100ms Wait → kleiner; (kein Sleep für 60s in Tests)

### 10.2 Manuelle E2E-Verifikation in Discord

Wird als Task am Ende des Implementation-Plans aufgelistet. Mindestens 12 Szenarien:

1. Owner: `/setup` → `/config channel set type:report channel:#reports` → `/report user:@alice reason:test`
2. Member ohne supporter: `/report ...` — funktioniert (kein Tier-Check)
3. Self-report blockiert
4. Bot-report blockiert
5. Nicht-Member-report blockiert
6. Duplicate-Report blockiert
7. Cooldown blockt 60s
8. Übernehmen durch Mod → Embed wechselt Farbe + assigned_mod
9. Übernehmen durch zweiten Mod → Embed re-assigned
10. Resolve → None → Embed grau, Status, kein Case
11. Resolve → Warn → Case #X erstellt, Embed grün, Mod-Log-Embed gepostet, target user nicht gewarnt-DM
12. Resolve → Timeout 10m → discord.js timeout aktiv, Case erstellt
13. Resolve → Kick durch Moderator → Tier-Fehler
14. Resolve → Kick durch Owner → User gekickt
15. Resolve → Ban durch Owner → User gebannt
16. Verwerfen mit Note → Embed rot, status='dismissed'
17. Race: Zwei Mods gleichzeitig Resolve → einer Erfolg, einer ephemeraler Race-Fehler
18. Report-Embed-Message manuell gelöscht → Folgeklick auf Buttons gehen ins Leere, DB-Status aktualisiert sich trotzdem
19. Report ohne configured report_channel → Hinweis

## 11. Open Questions / Future Work

- **`/case <N>` Reverse-Lookup zum Report** — wenn `infractions.case_number` mit `reports.resolution_case_number` gejoint wird, kann `/case <N>` den Report-ID anzeigen. Aktuell out-of-scope.
- **Re-Open / Un-Claim** — bewusst weggelassen. YAGNI.
- **Mod-Log-Builder-Refactor** — der duplizierte `buildModLogEmbed`-Code könnte in einen `src/modlog.js` Helper. Stage 2d Tech-Debt.
- **Report-Channel-Permission-Check** — Stage 2d könnte beim `/config channel set type:report` validieren, dass moderator+-Tier die `View Channel`-Permission auf dem Channel haben.

## 12. Rollback

- Kein irreversibles Schema (ALTER ist additiv, INDEX ist additiv).
- Bei Rollback: alte index.js, alte schema-File, neue Spalten/Index bleiben unbenutzt aber stören nichts.
- Reports-Tabelle bleibt mit etwaigen Test-Daten — können per DELETE manuell entfernt werden.
