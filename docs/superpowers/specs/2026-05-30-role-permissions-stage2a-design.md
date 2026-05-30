# Role-Permissions (Stage 2a)

**Status:** Approved
**Datum:** 2026-05-30
**Projekt:** Oreo Discord Bot
**Branch:** `feat/role-permissions-stage2a` (neuer Branch von `main`, nachdem Stage 1.5 gemerged ist)
**Spec-Vorgänger:** [2026-05-30-case-management-design.md](2026-05-30-case-management-design.md)
**Folge-Specs:** Stage 2b (`/config` Channels), Stage 2c (`/report`)

---

## Kontext & Motivation

Stage 1 und 1.5 haben die Mod-Commands (`/warn`, `/timeout`, `/kick`, `/ban`, `/removewarn`, `/reason`, …) ausgeliefert. Aktuelle Permission-Strategie:

```js
.setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
```

Das funktioniert für einen einzigen Server mit klassischer Discord-Permission-Struktur, aber:

- **Keine feingranulare Trennung:** Helper, Mod, Admin sind alle "ModerateMembers" — `/ban` und `/warnings` sind für dieselbe Personengruppe zugänglich.
- **Keine Server-spezifische Konfiguration:** Wer mit dem Bot arbeiten darf, ist Discord-Permission-getrieben. Server, die Mod-Rollen ohne `ModerateMembers`-Permission haben, sind ausgesperrt.
- **`MODLOG_CHANNEL_ID` ist env-getrieben:** Multi-Guild-Betrieb ist heute nicht möglich.

Stage 2a löst das Permission-Problem als Fundament für Stage 2b (`/config` Channels) und 2c (`/report`). Die `role_permissions`-Tabelle existiert seit Stage 1 als Placeholder und wird in dieser Stage **Single Source of Truth**.

---

## Ziele

1. `src/perms.js` — neues Modul: Tier-Resolver + Middleware-Helper
2. `/setup` — owner-only Bootstrap-Command, schreibt initiale Tier-Zuweisungen
3. `/config role set | unset | list` — Live-Editor für Tier-Zuweisungen, admin-tier-gegated
4. Middleware im `InteractionCreate`-Handler von `index.js` — prüft `command.requiredTier` vor `execute()`
5. Migration aller 11 bestehenden Commands auf das neue System
6. Entfernung aller `setDefaultMemberPermissions(...)`-Aufrufe in Mod-Commands
7. Lockout-Schutz: letzte Admin-Rolle kann nicht von einem Nicht-Owner-Admin entzogen werden

## Nicht-Ziele

- Keine `/config set`-Subcommands für Channels (`report_channel_id`, `mod_log_channel_id`) — **Stage 2b**
- Keine `/config set automod_enabled`, kein `/config show` — **Stage 2b**
- Keine `/report`-Implementation — **Stage 2c**
- Keine Schema-Migration (`role_permissions` existiert bereits)
- Kein Cache für Tier-Lookups (per-Request `SELECT` ist günstig genug)
- Keine bestätigenden Modale (kein "Bist du sicher?" — alle Aktionen sind reversibel via `/setup` oder `/config role`)
- Keine Tier-Vererbung à la "admin macht alles was mod kann" jenseits des numerischen Vergleichs (admin ≥ mod ≥ helper)

---

## Architektur (Delta zu Stage 1.5)

```
index.js                    (EDIT) — Tier-Check vor execute() im InteractionCreate-Handler
src/
├── perms.js                (NEU)  — Tier-Resolver + Middleware-Helper
├── commands/
│   ├── setup.js            (NEU)  — owner-only Bootstrap
│   ├── config.js           (NEU)  — Subcommand-Group "role"
│   ├── ping.js             (EDIT) — requiredTier: 'helper' + Default-Perms weg
│   ├── warn.js             (EDIT) — requiredTier: 'mod'
│   ├── timeout.js          (EDIT) — requiredTier: 'mod'
│   ├── untimeout.js        (EDIT) — requiredTier: 'mod'
│   ├── removewarn.js       (EDIT) — requiredTier: 'mod'
│   ├── reason.js           (EDIT) — requiredTier: 'mod'
│   ├── warnings.js         (EDIT) — requiredTier: 'helper'
│   ├── modhistory.js       (EDIT) — requiredTier: 'helper'
│   ├── case.js             (EDIT) — requiredTier: 'helper'
│   ├── ban.js              (EDIT) — requiredTier: 'admin'
│   ├── unban.js            (EDIT) — requiredTier: 'admin'
│   └── kick.js             (EDIT) — requiredTier: 'admin'
```

**Schema:** unverändert. `role_permissions` existiert seit Stage 1.

### Design-Prinzipien

- **Single Source of Truth:** `role_permissions` definiert alles. Kein Discord-Permission-Fallback.
- **Owner-Privileg nur für `/setup`:** Server-Owner hat keinen automatischen `admin`-Tier. Er kann jederzeit `/setup` ausführen, um sich (oder andere) wieder Tier zuzuweisen. Das verhindert den finalen Lockout, ohne den Resolver zu komplizieren.
- **Middleware statt Pro-Command-Code:** Tier-Check läuft zentral im `InteractionCreate`-Handler von `index.js`. Commands deklarieren nur `requiredTier`, der Dispatcher gated. `loadCommands.js` bleibt ein reiner File-Loader.
- **Orphan-tolerant:** Rollen, die auf Discord nicht mehr existieren, werden vom Resolver ignoriert. Cleanup ist Admin-Sache via `/config role unset`.
- **Lockout-Schutz für Nicht-Owner:** Wer nicht Owner ist, kann nicht die letzte Admin-Rolle entziehen — Recovery-Pfad bliebe sonst nur Bot-Neustart mit DB-Eingriff.

---

## Permission-Resolver (`src/perms.js`)

### Tier-Hierarchie

```js
const TIERS = {
  helper: 1,
  mod: 2,
  admin: 3,
};
```

### Public API

```js
/**
 * Liefert den höchsten Tier, den ein Member über seine Rollen hat.
 * Server-Owner hat KEINEN Sonderstatus (Single Source of Truth = role_permissions).
 * Ausnahme: /setup ist über die Owner-ID gegated, nicht über Tier.
 * @returns {Promise<'helper'|'mod'|'admin'|null>}
 */
exports.getEffectiveTier = async (guildId, member) => string|null;

/**
 * Prüft ob Member mindestens den geforderten Tier hat.
 * @param {'helper'|'mod'|'admin'} requiredTier
 * @returns {Promise<boolean>}
 */
exports.hasTier = async (guildId, member, requiredTier) => boolean;

/**
 * Middleware-Helper: prüft Tier, antwortet ephemeral wenn nicht erlaubt.
 * Wird vom InteractionCreate-Handler in index.js aufgerufen, bevor execute() läuft.
 * Bei DB-Failure: ephemeral "Datenbankfehler" + return false + console.error.
 * @returns {Promise<boolean>}  true wenn erlaubt, false wenn schon geantwortet
 */
exports.requireTier = async (interaction, requiredTier) => boolean;
```

### Resolver-Logik

```js
exports.getEffectiveTier = async (guildId, member) => {
  if (!member) return null;
  const [rows] = await getPool().execute(
    'SELECT role_id, permission FROM role_permissions WHERE guild_id = ?',
    [guildId],
  );
  const tierByRole = new Map(rows.map(r => [String(r.role_id), r.permission]));
  let highest = 0;
  let tierName = null;
  for (const roleId of member.roles.cache.keys()) {
    const tier = tierByRole.get(roleId);
    if (!tier) continue;
    if (TIERS[tier] > highest) {
      highest = TIERS[tier];
      tierName = tier;
    }
  }
  return tierName;
};
```

### Edge-Cases

| Situation | Verhalten |
|---|---|
| `member` ist `null` (User left mid-flight) | `getEffectiveTier` → `null`, `requireTier` → ephemeral "Member nicht gefunden" |
| Rolle in DB existiert nicht mehr auf Discord | `member.roles.cache.get(roleId)` ist `undefined` → ignoriert (orphan-tolerant) |
| `role_permissions` leer für Guild | `getEffectiveTier` → `null` → alle Mod-Cmds gesperrt (außer `/setup` für Owner) |
| Member hat 3 Rollen mit verschiedenen Tiers | Höchster Tier gewinnt |
| DB-Failure beim `SELECT` | `requireTier` antwortet ephemeral "Datenbankfehler" + console.error, returnt false |

**Caching:** Bewusst keiner. Eine `SELECT` pro Command-Aufruf ist trivial (Tabelle hat wenige Zeilen pro Guild, PRIMARY KEY (guild_id, role_id)). Cache hätte Invalidierungs-Komplexität bei `/config role set`.

---

## Middleware (`index.js` InteractionCreate-Handler)

### Command-Vertrag

Jeder Command-Export bekommt ein zusätzliches Feld:

```js
module.exports = {
  data: new SlashCommandBuilder()...,
  requiredTier: 'mod',   // 'helper' | 'mod' | 'admin' | null
  async execute(interaction) { ... },
};
```

`null` (oder fehlend) = öffentlich, kein Check. Heute hat keiner der bestehenden Commands `null`, aber für künftige öffentliche Commands (z.B. `/help`) offen.

### Dispatcher-Änderung

Im `InteractionCreate`-Handler von `index.js` läuft vor `command.execute(interaction)` ein Tier-Check. Autocomplete-Interactions sind davon ausgenommen (kein User-facing Reply möglich, kein Schaden).

```js
if (command.requiredTier && !(await perms.requireTier(interaction, command.requiredTier))) {
  return;   // perms.requireTier hat schon ephemeral geantwortet
}
await command.execute(interaction);
```

`loadCommands.js` bleibt unverändert — es lädt nur Files in die Map und kennt die Tier-Logik nicht.

### `setDefaultMemberPermissions` — wird entfernt

Heute hat jeder Mod-Command `setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)`. Das versteckt den Command in Discord für User ohne diese Permission und kollidiert mit unserem neuen System: ein User mit `admin`-Tier in `role_permissions` ohne `ModerateMembers`-Permission würde den Command nicht sehen.

**Lösung:** Alle `setDefaultMemberPermissions(...)` raus aus den 11 bestehenden Commands. Tier-Middleware ist der einzige Gate. Commands sind in Discord für jeden sichtbar, werden aber bei fehlendem Tier ephemeral abgewiesen.

**Ausnahmen:** `/setup` und `/config` bekommen `setDefaultMemberPermissions(0)` → versteckt für alle außer Owner in der Discord-UI. Owner ignoriert Default-Perms; der echte Gate ist im Handler (Owner-Check bzw. `admin`-Tier).

### Fail-Trace

Wenn `requireTier` ephemeral antwortet, loggt der Dispatcher (Info-Level — Normalbetrieb, kein Fehler):

```js
console.info(`[perms] ${interaction.user.tag} blocked from /${command.data.name} (tier required: ${command.requiredTier})`);
```

---

## `/setup`-Command

### Slash-Schema

```
/setup
  admin-role:<Role>      (REQUIRED) — bekommt 'admin'-Tier
  mod-role:<Role>        (optional) — bekommt 'mod'-Tier
  helper-role:<Role>     (optional) — bekommt 'helper'-Tier
```

Eine Rolle pro Tier. Wer mehrere Rollen je Tier braucht, nutzt `/config role set` hinterher.

### Owner-Gate

Erste Zeile im Handler:

```js
if (interaction.user.id !== interaction.guild.ownerId) {
  return interaction.reply({
    content: 'Nur der Server-Inhaber kann /setup ausführen.',
    flags: MessageFlags.Ephemeral,
  });
}
```

`requiredTier` ist **nicht** gesetzt (Middleware würde leerlaufen, weil `role_permissions` initial leer ist).

### Semantik (Reset-Pattern)

`/setup` ist destruktiv — überschreibt alle existierenden `role_permissions`-Einträge der Guild:

```sql
START TRANSACTION;
DELETE FROM role_permissions WHERE guild_id = ?;
INSERT INTO role_permissions (guild_id, role_id, permission) VALUES (?,?,'admin');
-- mod-role/helper-role nur wenn übergeben
COMMIT;
```

### Validations

| Check | Verhalten |
|---|---|
| Rolle ist `@everyone` (`roleId === guildId`) | Abbruch: *"Die @everyone-Rolle kann nicht zugewiesen werden."* |
| Rolle ist `role.managed` (Bot-/Integration-Rolle) | Abbruch: *"Bot-/Integration-Rollen können nicht zugewiesen werden."* |
| Doppelte Rolle (admin-role === mod-role o.ä.) | Abbruch: *"Eine Rolle kann nicht mehreren Tiers zugewiesen werden."* |
| DB-Failure | Rollback + ephemeral *"Datenbankfehler — versuch's später."* |

### Reply-UX

```
✅ Setup abgeschlossen
Admin:  @Admins
Mod:    @Moderatoren
Helper: (nicht gesetzt)

3 Rollen konfiguriert. Weitere Zuweisungen via /config role set.
```

Ephemeral. Mod-Log: **kein Eintrag** (Bootstrap ist Server-Admin-Sache).

### Slash-Builder

```js
.setDefaultMemberPermissions(0)
```

Versteckt `/setup` für alle außer Owner.

---

## `/config role`-Subcommands

`/config` ist in Stage 2a **nur** eine Subcommand-Group für Rollen-Verwaltung. Channel-/Feature-Subcommands kommen in Stage 2b.

### Slash-Schema

```
/config role set    role:<Role> tier:<Choice:helper|mod|admin>
/config role unset  role:<Role>
/config role list
```

Command-Level: `setDefaultMemberPermissions(0)` + Datei deklariert `requiredTier: 'admin'`. Owner kommt durch Default-Perms-Bypass auf den Command und scheitert dann am Tier-Check, wenn er keine `admin`-Rolle hat — konsistent mit der "Single Source of Truth"-Linie.

### `/config role set`

**Verhalten:** Upsert in `role_permissions`.

```sql
INSERT INTO role_permissions (guild_id, role_id, permission)
VALUES (?, ?, ?)
ON DUPLICATE KEY UPDATE permission = VALUES(permission);
```

**Validations:**

| Check | Verhalten |
|---|---|
| Rolle ist `@everyone` | Abbruch: *"Die @everyone-Rolle kann nicht zugewiesen werden."* |
| Rolle ist `role.managed` | Abbruch: *"Bot-/Integration-Rollen können nicht zugewiesen werden."* |
| Rolle hat bereits genau diesen Tier | Reply (no-op): *"Rolle @X war bereits Tier 'mod'."* |
| DB-Failure | Ephemeral *"Datenbankfehler — versuch's später."* |

**Reply (Erfolg):**
- Neu: *"Rolle @Moderatoren hat jetzt Tier 'mod'."*
- Update: *"Rolle @Moderatoren wurde von Tier 'helper' auf 'mod' geändert."*

### `/config role unset`

**Verhalten:** `DELETE FROM role_permissions WHERE guild_id = ? AND role_id = ?`.

**Lockout-Schutz (kritisch):**

Wenn nach `DELETE` keine `admin`-Rolle mehr in der Guild ist UND der ausführende User nicht Server-Owner ist, dann Rollback + ephemeral:

> *"Abbruch — das wäre die letzte Admin-Rolle. Setze erst eine andere Rolle auf 'admin' oder lass den Server-Owner das machen."*

Server-Owner darf sich in den Lockout begeben (er kann eh per `/setup` raus), Nicht-Owner-Admins nicht.

**Implementation:** Transaktion mit `SELECT ... FOR UPDATE` auf admin-rows zur Vermeidung von Race-Conditions:

```sql
START TRANSACTION;
DELETE FROM role_permissions WHERE guild_id = ? AND role_id = ?;
SELECT COUNT(*) AS admin_count FROM role_permissions WHERE guild_id = ? AND permission = 'admin' FOR UPDATE;
-- wenn admin_count = 0 UND user.id !== guild.ownerId: ROLLBACK + ephemeral
COMMIT;
```

**Replies (Erfolg):**
- Erfolg: *"Rolle @X hat keinen Tier mehr (entfernt)."*
- Nicht vorhanden: *"Rolle @X hatte keinen Tier — nichts zu tun."*

### `/config role list`

**Verhalten:** Embed mit allen Zuweisungen, sortiert nach Tier (admin → mod → helper).

```
🛡️ Permission-Konfiguration

ADMIN
  @Admins
  @Senior-Mods

MOD
  @Moderatoren
  @Junior-Mods

HELPER
  @Helper

(keine Rolle für Tier X → "—")
```

**Stale-Roles** (Rolle in DB existiert auf Discord nicht mehr): mit `⚠️ (gelöscht)`-Badge anzeigen. Nicht automatisch aufräumen — Admin entscheidet selbst via `/config role unset`.

**Empty-State:** *"Keine Rollen konfiguriert. Nutze /setup oder /config role set."*

---

## Migration der bestehenden Commands

### Mechanisches Pattern

Pro Command:

1. `requiredTier`-Feld am Export hinzufügen
2. `.setDefaultMemberPermissions(...)` aus dem SlashCommandBuilder entfernen
3. `PermissionFlagsBits` aus dem `require('discord.js')`-Destructuring entfernen, falls dadurch ungenutzt
4. Existierende manuelle Permission-Checks im Handler (Rollen-Hierarchie, Bot-Capability, Owner-/Bot-Self-Targeting) **bleiben** — sind unabhängig vom Tier-System

### Beispiel-Diff (für `/warn`)

```diff
-const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
+const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
 const cases = require('../cases');

 module.exports = {
   data: new SlashCommandBuilder()
     .setName('warn')
     .setDescription('Verwarnt einen Nutzer und speichert es als Case.')
     .addUserOption((option) => option.setName('target').setDescription('Wer soll verwarnt werden?').setRequired(true))
-    .addStringOption((option) => option.setName('reason').setDescription('Grund für die Verwarnung').setRequired(false))
-    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
+    .addStringOption((option) => option.setName('reason').setDescription('Grund für die Verwarnung').setRequired(false)),
+  requiredTier: 'mod',

   async execute(interaction) {
```

### Tier-Zuweisung (vollständig)

| Command | Tier |
|---|---|
| `/ping` | `helper` |
| `/warnings` | `helper` |
| `/modhistory` | `helper` |
| `/case` | `helper` |
| `/warn` | `mod` |
| `/timeout` | `mod` |
| `/untimeout` | `mod` |
| `/removewarn` | `mod` |
| `/reason` | `mod` |
| `/ban` | `admin` |
| `/unban` | `admin` |
| `/kick` | `admin` |

### Was NICHT migriert wird

- Manuelle Owner-Checks (z.B. *"Den Server-Inhaber kannst du nicht verwarnen"* in `/warn`) — Geschäftslogik, bleiben
- Bot-Member-Checks (*"Oreo kann sich nicht selber verwarnen"*) — bleiben
- Discord-Capability-Checks (`.bannable`, `.kickable`, `.moderatable`) — bleiben, prüfen Bot-Berechtigung gegen Target

---

## Fehlerverhalten

| Situation | Verhalten | DB-Zustand |
|---|---|---|
| User ohne Tier ruft `/warn` auf | Ephemeral *"Du brauchst Tier 'mod' oder höher"* | unverändert |
| Owner ruft `/setup` ohne `admin-role` | Discord rejects (REQUIRED-Option fehlt) | unverändert |
| Nicht-Owner ruft `/setup` auf | Ephemeral *"Nur der Server-Inhaber kann /setup ausführen."* | unverändert |
| `/setup` mit gleicher Rolle für 2 Tiers | Abbruch, ephemeral, kein DELETE | unverändert |
| `/config role set` mit `@everyone` | Abbruch, ephemeral | unverändert |
| `/config role unset` letzte Admin-Rolle, User ist nicht Owner | Rollback, ephemeral Lockout-Warnung | unverändert |
| `/config role unset` letzte Admin-Rolle, User ist Owner | DELETE läuft durch | letzte Admin-Zeile entfernt |
| Rolle wird auf Discord gelöscht, Eintrag bleibt in DB | Resolver ignoriert (orphan-tolerant) | unverändert; `/config role list` zeigt ⚠️ |
| `role_permissions` leer + nicht-Owner ruft Mod-Cmd | Ephemeral *"Du brauchst Tier 'mod' …"* | unverändert |
| DB unreachable beim Tier-Check | Middleware → ephemeral *"Datenbankfehler"* + console.error | unverändert |

**Leitprinzip:** Tier-Checks sind günstig und idempotent. Fehler im Tier-Check führen NIE zu unauthorisierten Aktionen — bei Zweifel wird abgewiesen ("fail closed").

---

## Testing (manuell)

| # | Szenario | Erwartung |
|---|---|---|
| 1 | Frisches Deployment, Owner ruft `/setup admin-role:@Admins` | DB hat 1 Zeile, Reply listet Admin |
| 2 | Nicht-Owner ruft `/setup …` | Ephemeral "Nur der Server-Inhaber …" |
| 3 | Owner ruft `/setup` mit doppelter Rolle (admin=mod) | Ephemeral, kein DELETE |
| 4 | User mit @Admins ruft `/ban` | Ban läuft durch (Tier admin ≥ admin) |
| 5 | User mit @Moderatoren ruft `/ban` | Ephemeral "Tier admin oder höher" |
| 6 | User mit @Moderatoren ruft `/warn` | Warn läuft durch (Tier mod ≥ mod) |
| 7 | User mit @Helper ruft `/case 1` | Embed wird angezeigt (Tier helper ≥ helper) |
| 8 | User mit @Helper ruft `/warn` | Ephemeral "Tier mod oder höher" |
| 9 | User ohne zugewiesene Rolle ruft `/ping` | Ephemeral "Tier helper oder höher" |
| 10 | Admin ruft `/config role set @Helper2 tier:helper` | Reply "@Helper2 hat jetzt Tier 'helper'" |
| 11 | Admin ruft `/config role set` auf bereits gesetzte Rolle | Reply "wurde von X auf Y geändert" oder "war bereits …" |
| 12 | Admin ruft `/config role unset` für eigene letzte Admin-Rolle | Rollback, Lockout-Warnung |
| 13 | Owner ruft `/config role unset` für eigene letzte Admin-Rolle | DELETE läuft durch (Owner darf) |
| 14 | `/config role list` mit gelöschter Discord-Rolle in DB | Eintrag mit ⚠️ Badge |
| 15 | Owner ruft `/setup` zweimal mit verschiedenen Rollen | Erste Zuweisungen sind gelöscht, neue stehen |

---

## Roll-out

**Branch-Strategie:** Neuer Branch `feat/role-permissions-stage2a` von **frischem `main`**. Voraussetzung: Stage 1.5 (`feat/warn-cases-stage1`) ist zuerst nach `main` gemerged. Stage 2a wird nicht auf den noch offenen Stage-1.5-Branch draufgesetzt — vermischt zwei Konzepte und macht PR-Review zur Zumutung.

**Deploy-Schritte:**

1. Stage 1.5 (`feat/warn-cases-stage1`) zuerst mergen → `main`
2. `feat/role-permissions-stage2a` von frischem `main` branchen
3. Implementation laufen lassen
4. PR mergen
5. `docker compose up -d --build` auf Server
6. **`node src/deployCommands.js` einmal manuell** — Slash-Schemas ändern sich (kein `default_member_permissions` mehr, plus `/setup` + `/config`)
7. **Server-Owner führt sofort `/setup admin-role:@…` aus** — sonst sind ALLE Commands für ALLE gesperrt (Mod-Crew kann nichts mehr)

**Pre-Deploy-Warnung an Server-Owner:** Vor dem Merge eine Notiz im Operations-Channel:
> *"Nach Update sofort `/setup` ausführen. Bis dahin können Mods nichts. Owner kann immer recovern."*

**Rollback-Plan:** Vorherigen Container-Tag re-deployen. `role_permissions`-Tabelle bleibt — Stage-1.5-Code ignoriert sie. Discord-Side: `deployCommands.js` vom alten Tag laufen lassen, sonst bleiben `/setup` und `/config` als "tote" Commands sichtbar.

---

## Offene Punkte / Folge-Specs

- **Stage 2b:** `/config set` für Channels (`report_channel_id`, `mod_log_channel_id`), `/config set automod_enabled`, `/config show`. `MODLOG_CHANNEL_ID`-env-Fallback wird hier umgesetzt (DB überschreibt env, env als Fallback).
- **Stage 2c:** `/report` Command + Embed-Buttons (Übernehmen / Resolve / Verwerfen) + Resolve-Action-Modal mit Action-Dropdown (Warn/Timeout/Kick/Ban/None). DB-Migration: `reports.resolution_case_number` für Report↔Case-Link.
- **Migrations-Tool:** ab 5+ ALTER-Statements in `schema.sql` (Schwelle aus Stage 1.5-Spec übernommen).
