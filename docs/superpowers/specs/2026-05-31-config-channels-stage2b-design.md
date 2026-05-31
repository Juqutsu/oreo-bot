# Config-Channels (Stage 2b)

**Status:** Approved
**Datum:** 2026-05-31
**Projekt:** Oreo Discord Bot
**Branch:** TBD (`main` direkt oder `feat/config-channels-stage2b`)
**Spec-Vorgänger:** [2026-05-30-role-permissions-stage2a-design.md](2026-05-30-role-permissions-stage2a-design.md)
**Folge-Specs:** Stage 2c (`/report`), Stage 4 (Automod-Engine)

---

## Kontext & Motivation

Stage 2a hat das tier-basierte Permission-System (`supporter`/`moderator`/`owner`) etabliert. `/config role set/unset/list` ist live, alle Commands sind gegated. **Was fehlt:** Channels und Feature-Toggles, die ebenfalls per-Guild konfigurierbar sein sollten.

Aktuelle Situation:

- **`MODLOG_CHANNEL_ID` ist eine env-Variable** — Single-Server-Setup. Multi-Guild-Betrieb nicht möglich.
- **`report_channel_id` in der `guilds`-Tabelle** ist seit Stage 1 vorbereitet, aber kein Command schreibt darauf. Wartet auf Stage 2c (`/report`).
- **`automod_enabled` in der `guilds`-Tabelle** ist seit Stage 1 vorbereitet, aber Stage 4 schaltet erst die Behavior dazu.

Stage 2b stellt die Reader/Writer-Infrastruktur für diese drei Settings zur Verfügung. Die Channel-Migration ist die haupt-greifbare Verbesserung — 8 Mod-Commands (ban, kick, reason, removewarn, timeout, unban, untimeout, warn) hängen heute hardcoded am env-Var.

---

## Ziele

1. Neues Modul `src/config.js` — zentrale Read-API mit DB-first + env-Fallback
2. `/config channel set/unset/list` — Subcommands zum Verwalten von `report_channel_id` und `mod_log_channel_id`
3. `/config feature set` — Toggle für `automod_enabled` (Stub mit Forward-Kompatibilität für Stage 4)
4. `/config show` — One-stop Dashboard: Channels + Features + next_case_number + Rollen-Tier-Mappings
5. Migration der 8 Mod-Commands: `process.env.MODLOG_CHANNEL_ID` → `config.getModLogChannelId(guildId)`
6. Channel-Validation: SendMessages + EmbedLinks-Permissions vor DB-Write
7. Unconfigured-UX: Mod-Aktion läuft durch, ephemeraler Hinweis mit konkretem `/config`-Command

## Nicht-Ziele

- Kein `/report`-Command — **Stage 2c**
- Kein Embed-Button-Handling, kein Resolve-Action-Modal — **Stage 2c**
- Keine Automod-Engine, kein Behavior für `automod_enabled` — **Stage 4**
- Kein Cache für Config-Lookups (per-Request `SELECT` auf PRIMARY KEY ist trivial)
- Kein Lockout-Schutz für `mod_log_channel_id` (env-Fallback + ephemerale Hinweise reichen — niemand kann sich aussperren)
- Keine Test-Message beim Channel-Set (zu invasiv, Permission-Check reicht)
- Keine Schema-Änderungen (alle Spalten existieren seit Stage 1)

---

## Architektur (Delta zu Stage 2a)

```
src/
├── config.js               (NEU)  — Per-Guild-Config-Reader + env-Fallback
├── commands/
│   ├── config.js           (EDIT) — Neue Subcommand-Groups channel/feature + show-Subcommand
│   ├── ban.js              (EDIT) — getModLogChannelId statt process.env
│   ├── kick.js             (EDIT) — dito
│   ├── reason.js           (EDIT) — dito
│   ├── removewarn.js       (EDIT) — dito
│   ├── timeout.js          (EDIT) — dito
│   ├── unban.js            (EDIT) — dito
│   ├── untimeout.js        (EDIT) — dito
│   └── warn.js             (EDIT) — dito
```

**Schema:** unverändert. `guilds`-Tabelle hat seit Stage 1 die Spalten `report_channel_id`, `mod_log_channel_id`, `automod_enabled`, `next_case_number`.

### Design-Prinzipien

- **DB-first, env-Fallback:** Für `mod_log_channel_id` gilt Lookup-Reihenfolge `guilds.mod_log_channel_id` → `process.env.MODLOG_CHANNEL_ID` → `null`. Single-Server-Setups laufen weiter ohne `/config`-Aufruf.
- **Reader-Modul separiert von Writer-Logik:** `src/config.js` liest nur. Schreiben passiert direkt in `src/commands/config.js` (analog zum bestehenden `/config role`-Pattern, das auch keinen separaten Writer-Helper hat).
- **Fail-soft bei Mod-Log-Send:** Wenn der Channel nicht konfiguriert/erreichbar ist, blockt das die Mod-Aktion nicht. Nur ein ephemeraler Hinweis.
- **Channel-Validation:** Permission-Check (SendMessages + EmbedLinks) vor DB-Write. Verhindert die wahrscheinlichste Fehlkonfiguration.
- **Forward-kompatibles Feature-Toggle:** `/config feature set name:<Choice>` lässt sich Stage 4 um weitere Toggles ohne Strukturwechsel ergänzen.

---

## Reader-Modul (`src/config.js`)

### Public API

```js
/**
 * Liefert die mod-log-channel-ID für eine Guild.
 * Reihenfolge: 1) guilds.mod_log_channel_id, 2) process.env.MODLOG_CHANNEL_ID, 3) null.
 * @param {string} guildId
 * @returns {Promise<string|null>}  Snowflake-String oder null wenn nicht konfiguriert
 */
exports.getModLogChannelId = async (guildId) => string|null;

/**
 * Liefert die report-channel-ID. Kein env-Fallback.
 * @param {string} guildId
 * @returns {Promise<string|null>}
 */
exports.getReportChannelId = async (guildId) => string|null;

/**
 * Liefert ob automod für die Guild aktiviert ist. Default: false.
 * @param {string} guildId
 * @returns {Promise<boolean>}
 */
exports.isAutomodEnabled = async (guildId) => boolean;
```

### Implementierung

```js
const { getPool } = require('./db');

async function readGuildRow(guildId) {
  const [rows] = await getPool().execute(
    'SELECT mod_log_channel_id, report_channel_id, automod_enabled FROM guilds WHERE guild_id = ?',
    [guildId],
  );
  return rows[0] ?? null;
}

exports.getModLogChannelId = async (guildId) => {
  const row = await readGuildRow(guildId);
  const dbValue = row?.mod_log_channel_id ?? null;
  if (dbValue) return String(dbValue);
  return process.env.MODLOG_CHANNEL_ID || null;
};

exports.getReportChannelId = async (guildId) => {
  const row = await readGuildRow(guildId);
  return row?.report_channel_id ? String(row.report_channel_id) : null;
};

exports.isAutomodEnabled = async (guildId) => {
  const row = await readGuildRow(guildId);
  return Boolean(row?.automod_enabled);
};
```

### Edge-Cases

| Situation | Verhalten |
|---|---|
| Guild-Row existiert nicht in `guilds` | `readGuildRow` → `null`. Für mod_log: env-Fallback → null. Für report/automod: null/false. |
| DB unreachable | Wirft Exception, die der Consumer fangen muss (analog zu `perms.js` — kein silent default). |
| env MODLOG_CHANNEL_ID ist leerer String | `dbValue \|\| null` greift; bei leerem env wird null zurückgegeben. |
| BIGINT-as-string | mysql2-Pool ist `bigNumberStrings: true` konfiguriert → `row.mod_log_channel_id` ist bereits String, `String()` ist defensive no-op. |

**Caching:** Bewusst keiner. Tabelle ist klein, Writes über `/config` sind selten, Cache-Invalidation wäre Komplexität ohne Nutzen. Ein PRIMARY-KEY-Lookup pro Mod-Aktion ist sub-Millisekunde.

**3 Reads pro Show-Call:** `/config show` ruft alle drei Helper auf → 3 SELECTs. Akzeptabel, weil `/config show` selten genutzt wird und ein Embed-Bau ohnehin teurer als 3 Queries ist.

---

## `/config`-Erweiterung

Die bestehende `/config role`-Subgroup bleibt unverändert. Neu kommen `/config channel`, `/config feature`, `/config show` hinzu.

### Slash-Schema

```
/config
├── role
│   ├── set    role:<Role> tier:<Choice:supporter|moderator|owner>
│   ├── unset  role:<Role>
│   └── list                                          (existiert)
├── channel
│   ├── set    type:<Choice:report|modlog> channel:<Channel>
│   ├── unset  type:<Choice:report|modlog>
│   └── list                                          (NEU)
├── feature
│   └── set    name:<Choice:automod>   value:<Boolean>     (NEU)
└── show                                              (NEU, top-level Subcommand)
```

**Permission:** unverändert `requiredTier: 'owner'`, `setDefaultMemberPermissions(0)`.

**Choice für `feature`:** Aktuell nur `automod`. Choice-Liste ist forward-compatible — Stage 4 kann weitere Toggles ergänzen ohne Strukturwechsel.

### `/config channel set type:<...> channel:<#x>`

**Validations:**

| Check | Verhalten |
|---|---|
| `channel.type !== ChannelType.GuildText` | Ephemeral *"Nur Text-Channels werden unterstützt."* |
| Bot fehlt `SendMessages`-Permission im Channel | Ephemeral *"Mir fehlt die Permission 'Nachrichten senden' in <#channel>. Bitte zuerst beheben."* |
| Bot fehlt `EmbedLinks`-Permission im Channel | Ephemeral *"Mir fehlt die Permission 'Embed-Links' in <#channel>. Bitte zuerst beheben."* |
| DB-Failure | Ephemeral *"Datenbankfehler — versuch es später."* |

**Verhalten:**

```sql
INSERT IGNORE INTO guilds (guild_id) VALUES (?);
UPDATE guilds SET <col> = ? WHERE guild_id = ?;
```

`<col>` ist `mod_log_channel_id` (wenn `type=modlog`) bzw. `report_channel_id` (wenn `type=report`). SELECT vor UPDATE liest den alten Wert für die "von <#old> auf <#new>"-Reply.

**Reply (ephemeral):**

- Neu gesetzt: *"Channel `modlog` gesetzt auf <#x>."*
- Update: *"Channel `modlog` von <#old> auf <#new> geändert."*

### `/config channel unset type:<...>`

**Verhalten:** `UPDATE guilds SET <col> = NULL WHERE guild_id = ?`. Vorher SELECT für die "war <#x>"-Reply.

**Reply:**

- War gesetzt: *"Channel `modlog` entfernt (war <#x>)."*
- War nicht gesetzt: *"Channel `modlog` war nicht konfiguriert — nichts zu tun."*

**Kein Lockout-Schutz** — env-Fallback und ephemerale Hinweise verhindern Aussperrung.

### `/config channel list`

**Verhalten:** Embed mit beiden Channels.

```
🔧 Channel-Konfiguration

Report-Channel:   <#x>   (oder: nicht konfiguriert)
Mod-Log-Channel:  <#y>   (oder: nicht konfiguriert — env-Fallback aktiv: <#env-id>)
```

Wenn der DB-Wert leer ist und env-Fallback greift, zeigt das Embed das **explizit** — sonst Verwirrung warum Mod-Log funktioniert ohne sichtbare Config.

### `/config feature set name:<automod> value:<Boolean>`

**Verhalten:**

```sql
INSERT IGNORE INTO guilds (guild_id) VALUES (?);
UPDATE guilds SET automod_enabled = ? WHERE guild_id = ?;
```

**Reply:**

- `value=true`: *"Feature `automod` aktiviert."* + ⚠️ *"Automod-Logik ist erst ab Stage 4 implementiert. Toggle ist heute ein Stub."*
- `value=false`: *"Feature `automod` deaktiviert."*

### `/config show`

**Verhalten:** Ein großes Embed mit allen Config-Werten der Guild.

```
🛡️ Server-Konfiguration

📺 CHANNELS
  Report:   <#x>  (oder: nicht konfiguriert)
  Mod-Log:  <#y>  (oder: nicht konfiguriert — env-Fallback)

⚙️ FEATURES
  Automod:  ✅ aktiv  (oder: ❌ deaktiviert)

📊 STATISTIKEN
  Nächste Case-Nr:  #42

🔐 ROLLEN-TIERS
  OWNER:      @Admins
  MODERATOR:  @Moderatoren, @Junior-Mods
  SUPPORTER:  @Helper
                            (oder: keine Rollen konfiguriert)
```

**Queries:** 1 SELECT auf `guilds` + 1 SELECT auf `role_permissions`. Bau eines `EmbedBuilder` mit vier Feldern.

**Footer:** `🐾 Oreo`

---

## Migration der 8 Mod-Commands

### Pattern (alle 8 identisch)

**Vorher:**

```js
try {
  const logChannel = await interaction.client.channels.fetch(process.env.MODLOG_CHANNEL_ID);
  const modEmbed = new EmbedBuilder()...;
  await logChannel.send({ embeds: [modEmbed] });
} catch (e) {
  console.warn('ModLog send failed:', e);
  await interaction.followUp({
    content: 'Mod-Log-Eintrag fehlgeschlagen. Bitte `MODLOG_CHANNEL_ID` prüfen.',
    flags: MessageFlags.Ephemeral,
  });
}
```

**Nachher:**

```js
const config = require('../config');

try {
  const channelId = await config.getModLogChannelId(interaction.guildId);
  if (!channelId) {
    await interaction.followUp({
      content: 'Mod-Log nicht konfiguriert. Admin: `/config channel set type:modlog channel:<#x>` ausführen.',
      flags: MessageFlags.Ephemeral,
    });
  } else {
    const logChannel = await interaction.client.channels.fetch(channelId);
    const modEmbed = new EmbedBuilder()...;
    await logChannel.send({ embeds: [modEmbed] });
  }
} catch (e) {
  console.warn('ModLog send failed:', e);
  await interaction.followUp({
    content: 'Mod-Log-Eintrag fehlgeschlagen — Channel-Permission oder Channel-ID prüfen.',
    flags: MessageFlags.Ephemeral,
  });
}
```

**Geschäftslogik bleibt unverändert** in allen 8 Commands:
- Mod-Aktion (Ban/Kick/Warn/etc.) läuft durch
- Case wird in DB erstellt
- DM an Target (best-effort)
- Ephemeraler Reply an Mod
- Mod-Log-Send-Block läuft danach, skippt jetzt sauber statt zu crashen

**Env-Variable bleibt funktional:** `MODLOG_CHANNEL_ID` ist nicht mehr Primärquelle, aber als Fallback live. `.env.example` und Docker-Setup bleiben unverändert für rückwärtskompatible Single-Server-Deployments.

---

## Fehlerverhalten

| Situation | Verhalten | DB-Zustand |
|---|---|---|
| `/config channel set` mit Voice-Channel | Ephemeral *"Nur Text-Channels werden unterstützt."* | unverändert |
| `/config channel set` mit Channel, in dem Bot keine SendMessages-Perm hat | Ephemeral mit konkreter Permission-Lücke | unverändert |
| `/config channel set` mit Channel, in dem Bot keine EmbedLinks-Perm hat | Ephemeral mit konkreter Permission-Lücke | unverändert |
| `/config channel unset` für nie konfigurierten Channel | Ephemeral *"war nicht konfiguriert"* | unverändert |
| `/config feature set automod true` | DB-Update + ephemeral "aktiviert" + Stub-Warnung | `automod_enabled = 1` |
| `/config show` ohne Guild-Row in DB | Embed mit "nicht konfiguriert" für alle Felder, env-Fallback wenn vorhanden | unverändert |
| `/config show` mit aktivem env-Fallback | Embed zeigt `Mod-Log: <#env>  (env-Fallback)` | unverändert |
| Mod-Command ohne mod_log_channel UND ohne env | Mod-Aktion läuft durch, ephemeraler Hinweis mit `/config channel set` | unverändert |
| Mod-Command mit konfiguriertem Channel, aber Bot wurde aus Channel rausgeschmissen | `channels.fetch` oder `send` wirft → catch → ephemeral Permission-Hinweis | unverändert |
| `getModLogChannelId` DB-Failure | Wirft Exception, Consumer catched → ephemeral Permission-/Channel-Hinweis | unverändert |
| User ohne owner-Tier ruft `/config show` | Middleware blockt vor execute, ephemeral *"Tier 'owner' oder höher"* | unverändert |

**Leitprinzip:** Config-Reads sind günstig und idempotent. Fehler beim Mod-Log-Send blockieren nie die eigentliche Mod-Aktion (Warn/Ban/etc. ist die primäre Verantwortung; Log ist Beobachter).

---

## Testing (manuell)

| # | Szenario | Erwartung |
|---|---|---|
| 1 | Frische DB, owner ruft `/config show` | Embed zeigt alles "nicht konfiguriert", Rollen-Sektion zeigt Owner-Rolle (aus `/setup`) |
| 2 | `/config channel set type:modlog channel:#mod-log` | Reply "Channel `modlog` gesetzt auf <#mod-log>." |
| 3 | `/config channel set type:modlog channel:<voice-channel>` | Ephemeral "Nur Text-Channels werden unterstützt." |
| 4 | `/config channel set` auf Channel ohne Bot-SendMessages-Perm | Ephemeral konkrete Permission-Lücke, kein DB-Update |
| 5 | `/config channel set type:modlog` auf bereits gesetzten Channel | Reply "von <#old> auf <#new> geändert" |
| 6 | `/config channel unset type:modlog` | Reply "Channel `modlog` entfernt (war <#x>)." |
| 7 | `/config channel unset` für nie konfigurierten Channel | Reply "war nicht konfiguriert" |
| 8 | `/config channel list` mit beiden Channels konfiguriert | Embed zeigt beide Channels mit Mentions |
| 9 | `/config channel list` mit nur env-MODLOG_CHANNEL_ID gesetzt | Mod-Log zeigt `<#env-id> (env-Fallback aktiv)` |
| 10 | `/config feature set name:automod value:true` | Reply "aktiviert" + Stub-Warnung |
| 11 | `/config feature set name:automod value:false` | Reply "deaktiviert", keine Warnung |
| 12 | `/config show` mit allem konfiguriert | Embed mit 4 Sektionen (Channels/Features/Stats/Rollen), alles korrekt |
| 13 | `/warn` mit gesetztem `mod_log_channel` in DB | Warn läuft, Mod-Log landet im DB-Channel (nicht env) |
| 14 | `/warn` ohne DB-Channel, aber mit env | Warn läuft, Mod-Log landet im env-Channel |
| 15 | `/warn` ohne DB-Channel UND ohne env | Warn läuft, ephemeral followUp "Mod-Log nicht konfiguriert. Admin: `/config channel set …`" |
| 16 | `/warn` mit DB-Channel-ID, die ungültig/gelöscht ist | Warn läuft, ephemeral followUp Permission-Hinweis |
| 17 | User ohne owner-Tier ruft `/config show` | Ephemeral "Tier 'owner' oder höher" |

---

## Roll-out

**Branch-Strategie:** Stage 2a ist bereits direkt auf `main` gemerged (lokal, noch nicht gepusht). Vorschlag für Stage 2b: ebenso `main` (ein Branch für die ganze 2er-Stage-Serie). Alternative: `feat/config-channels-stage2b` + PR.

**Deploy-Schritte:**

1. Code-Änderungen committen
2. Push zu `origin/main` (inkl. aller pending Stage-2a + 2b Commits)
3. `docker compose up -d --build` auf Server
4. Auto-Deploy via `index.js`-Startup-IIFE registriert die neuen Subcommands (`/config channel`, `/config feature`, `/config show`) in Discord
5. **Keine Pflicht-Aktion** für Server-Owner — env-Fallback hält den Bot funktional. Wer dauerhaft Multi-Guild oder explizite Per-Guild-Config will, kann `/config channel set type:modlog channel:<#x>` ausführen.

**Pre-Deploy-Hinweis:** Keine Breaking-Change. Existierende Mod-Commands funktionieren identisch wie vor Stage 2b. Neue Subcommands sind additiv.

**Rollback:** Vorherigen Container-Tag re-deployen. DB bleibt — Spalten existieren seit Stage 1, neue Werte sind backward-kompatibel.

---

## Offene Punkte / Folge-Specs

- **Stage 2c:** `/report`-Command + Embed-Buttons + Resolve-Action-Modal mit Action-Dropdown (Warn/Timeout/Kick/Ban/None). Liest `report_channel_id` über `config.getReportChannelId(guildId)`. DB-Migration: `reports.resolution_case_number` für Report↔Case-Link.
- **Stage 4:** Automod-Engine. Schaltet die heutige `isAutomodEnabled`-Stub scharf.
- **Migrations-Tool:** Sobald `server/schema.sql` 5+ ALTER-Statements hat (aktuell 3), sollte ein Migration-Framework (nummerierte SQL-Files + `schema_migrations`-Tabelle) eingeführt werden.
