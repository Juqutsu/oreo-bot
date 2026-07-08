# Announcement-Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/announcement` von "einmalig posten" zu einem verwalteten Lebenszyklus ausbauen: Vorschau vor dem Posten, Bearbeiten, Löschen, Liste — DB-gestützt mit Autocomplete.

**Architecture:** Subcommands (`create|edit|delete|list`) auf dem bestehenden Command; neue Tabelle `announcements` + DAL `src/announcements.js` (Muster `src/reports.js`); Vorschau-Sessions in-memory mit 10-Min-TTL in `src/interactions/announcement.js` (Muster `pendingPuzzles` in captcha.js). Spec: `docs/superpowers/specs/2026-07-08-announcement-improvements-design.md` (approved).

**Tech Stack:** discord.js v14, CommonJS, mysql2/promise, plain-assert smoke tests (`tests/run.js` als Child-Prozesse).

## Global Constraints

- User-facing Strings **deutsch**, Code/Kommentare englisch (Datei-Stil beachten).
- CommonJS, keine neuen npm-Dependencies.
- index.js auto-deferred ephemeral + `interaction.reply`→`editReply`-Monkey-Patch; Commands mit Modal deklarieren `showsModal` (bool oder `(interaction) => boolean`). `showModal()` darf NIE nach einem Defer laufen.
- Alle Announcements-Subcommands: `requiredTier: 'moderator'`. Der Autocomplete-Tier-Gate in index.js greift automatisch über `command.requiredTier`.
- Mod-Logs fail-soft (`console.warn`, niemals den Haupt-Flow abbrechen).
- MySQL lokal ggf. nicht erreichbar: dann `node --check` + non-DB-Smoke-Tests; DB-Suiten validieren in CI (`npm test` läuft dort gegen MySQL 8.4). Neue DB-Suite MUSS dem Muster der bestehenden folgen (liest `.env` selbst, `tests/run.js` setzt `OREO_CONFIG_CACHE_TTL_MS=0`).
- Branch: `feat/announcement-lifecycle` von `main` abzweigen (Setup vor Task 1: `git checkout -b feat/announcement-lifecycle`). Push auf `main` triggert CI+Deploy — erst am Ende mergen.
- Commit nach jedem Task (`feat:`/`test:`/`docs:`).
- Arbeitsverzeichnis: `c:\Users\Lukas\Documents\Home Discord Bots\Oreo`.

---

### Task 1: Tabelle + DAL `src/announcements.js` + DB-Smoke-Test

**Files:**
- Modify: `server/schema.sql` (Tabelle anhängen, vor etwaigen staged ALTERs am Dateiende)
- Create: `src/announcements.js`
- Test: `tests/smoke/announcements.js`

**Interfaces:**
- Produces (von Tasks 2–5 konsumiert):
  - `createAnnouncement({ guildId, channelId, messageId, authorId, title, description, color = null, imageUrl = null, pingRoleId = null })` → `id` (Number)
  - `getAnnouncement(guildId, id)` → Row `{ id, guild_id, channel_id, message_id, author_id, title, description, color, image_url, ping_role_id, status, created_at, edited_at, edited_by }` oder `null` (nur `status='posted'` ODER beliebig — Row enthält status, Caller filtert nicht: get liefert auch deleted, damit Orphan-Cleanup möglich bleibt)
  - `listRecent(guildId, limit = 25)` → Rows (nur `status='posted'`, neueste zuerst)
  - `updateAnnouncement(guildId, id, { title, description, imageUrl, editedBy })` → void
  - `markDeleted(guildId, id)` → void

- [ ] **Step 1: Tabelle in server/schema.sql anhängen**

```sql
-- Announcements-Verwaltung (Lifecycle: Vorschau → posten → bearbeiten/löschen)
CREATE TABLE IF NOT EXISTS announcements (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  guild_id     BIGINT UNSIGNED NOT NULL,
  channel_id   BIGINT UNSIGNED NOT NULL,
  message_id   BIGINT UNSIGNED NOT NULL,
  author_id    BIGINT UNSIGNED NOT NULL,
  title        VARCHAR(256) NOT NULL,
  description  TEXT NOT NULL,
  color        INT UNSIGNED NULL,
  image_url    VARCHAR(512) NULL,
  ping_role_id BIGINT UNSIGNED NULL,
  status       ENUM('posted','deleted') NOT NULL DEFAULT 'posted',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  edited_at    DATETIME NULL,
  edited_by    BIGINT UNSIGNED NULL,
  INDEX idx_guild_status (guild_id, status, id)
);
```

- [ ] **Step 2: Failing Test schreiben** — `tests/smoke/announcements.js` (DB-gestützt, Muster `tests/smoke/reports.js` lesen und übernehmen: eigener `main()`, `process.exit`, Guild-Row per `INSERT IGNORE INTO guilds`):

```js
// Run with: node tests/smoke/announcements.js  (braucht MySQL aus .env)
const assert = require('node:assert/strict');

async function main() {
  const a = require('../../src/announcements');
  const { getPool } = require('../../src/db');
  const G = '999999999999999801';

  await getPool().execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [G]);
  await getPool().execute('DELETE FROM announcements WHERE guild_id = ?', [G]);

  console.log('Running Test 1: create + get...');
  const id = await a.createAnnouncement({
    guildId: G, channelId: '111', messageId: '222', authorId: '333',
    title: 'Test-Titel', description: 'Test-Beschreibung', color: 0x57f287,
    imageUrl: 'https://example.com/img.png', pingRoleId: null,
  });
  assert.ok(Number.isInteger(id) && id > 0, 'createAnnouncement returns numeric id');
  const row = await a.getAnnouncement(G, id);
  assert.equal(row.title, 'Test-Titel');
  assert.equal(String(row.message_id), '222');
  assert.equal(row.status, 'posted');
  console.log('   Test 1 passed');

  console.log('Running Test 2: listRecent...');
  const list = await a.listRecent(G, 25);
  assert.ok(list.some((r) => Number(r.id) === id), 'created row listed');
  console.log('   Test 2 passed');

  console.log('Running Test 3: update...');
  await a.updateAnnouncement(G, id, { title: 'Neu', description: 'Neu-Desc', imageUrl: null, editedBy: '444' });
  const edited = await a.getAnnouncement(G, id);
  assert.equal(edited.title, 'Neu');
  assert.equal(edited.image_url, null);
  assert.ok(edited.edited_at, 'edited_at set');
  assert.equal(String(edited.edited_by), '444');
  console.log('   Test 3 passed');

  console.log('Running Test 4: markDeleted (soft) verschwindet aus listRecent, get liefert weiter...');
  await a.markDeleted(G, id);
  const listAfter = await a.listRecent(G, 25);
  assert.ok(!listAfter.some((r) => Number(r.id) === id), 'deleted row not listed');
  const still = await a.getAnnouncement(G, id);
  assert.equal(still.status, 'deleted', 'get still returns row incl. status');
  console.log('   Test 4 passed');

  console.log('OK — announcements DAL smoke test passed');
  process.exit(0);
}
main().catch((err) => { console.error('FAIL', err); process.exit(1); });
```

- [ ] **Step 3: Test laufen lassen → erwarteter Fehler** `Cannot find module '../../src/announcements'` (bzw. bei fehlendem MySQL: notieren, CI validiert).

- [ ] **Step 4: `src/announcements.js` implementieren** (Muster `src/reports.js`: `const { getPool } = require('./db');`, `runner = conn ?? getPool()` ist hier nicht nötig — keine Transaktionen):

```js
const { getPool } = require('./db');

/** Persists a posted announcement. Returns the new row id. */
async function createAnnouncement({ guildId, channelId, messageId, authorId, title, description, color = null, imageUrl = null, pingRoleId = null }) {
  const [result] = await getPool().execute(
    `INSERT INTO announcements (guild_id, channel_id, message_id, author_id, title, description, color, image_url, ping_role_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [guildId, channelId, messageId, authorId, title, description, color, imageUrl, pingRoleId],
  );
  return result.insertId;
}

/** Returns the row (any status, so orphan cleanup can find deleted ones) or null. */
async function getAnnouncement(guildId, id) {
  const [rows] = await getPool().execute(
    'SELECT * FROM announcements WHERE guild_id = ? AND id = ?',
    [guildId, id],
  );
  return rows[0] ?? null;
}

/** Latest posted announcements, newest first. */
async function listRecent(guildId, limit = 25) {
  const [rows] = await getPool().execute(
    `SELECT * FROM announcements WHERE guild_id = ? AND status = 'posted' ORDER BY id DESC LIMIT ?`,
    [guildId, String(limit)],
  );
  return rows;
}

async function updateAnnouncement(guildId, id, { title, description, imageUrl, editedBy }) {
  await getPool().execute(
    `UPDATE announcements SET title = ?, description = ?, image_url = ?, edited_at = NOW(), edited_by = ?
     WHERE guild_id = ? AND id = ?`,
    [title, description, imageUrl ?? null, editedBy, guildId, id],
  );
}

async function markDeleted(guildId, id) {
  await getPool().execute(
    `UPDATE announcements SET status = 'deleted' WHERE guild_id = ? AND id = ?`,
    [guildId, id],
  );
}

module.exports = { createAnnouncement, getAnnouncement, listRecent, updateAnnouncement, markDeleted };
```

Hinweis: `LIMIT ?` mit mysql2 `execute` erwartet einen String/Number-Param — falls die MySQL-Version meckert, stattdessen `LIMIT ${Number(limit) || 25}` interpolieren (Number-Cast macht es injektionssicher). Bestehende DAL-Dateien auf das dort verwendete Muster prüfen und angleichen.

- [ ] **Step 5: Tests** — `node tests/smoke/announcements.js` (bei erreichbarem MySQL: `OK — announcements DAL smoke test passed`; sonst `node --check src/announcements.js` + Vermerk). 

- [ ] **Step 6: Commit** — `git add server/schema.sql src/announcements.js tests/smoke/announcements.js && git commit -m "feat: announcements table and DAL"`

---

### Task 2: Command-Umbau — Subcommands, Farb-Option, Autocomplete, showsModal

**Files:**
- Modify: `src/commands/announcement.js` (kompletter Umbau)

**Interfaces:**
- Consumes: `announcements.listRecent(guildId, 25)`, `announcements.getAnnouncement(guildId, id)` (Task 1).
- Produces (von Task 3–5 konsumiert):
  - Modal-CustomIds: `announcement:modal:create:<channelId>:<pingRoleId|none>:<colorKey>` und `announcement:modal:edit:<announcementId>`
  - Export `COLORS`: `{ blurple: 0x5865f2, gruen: 0x57f287, rot: 0xed4245, gelb: 0xfee75c, orange: 0xe67e22, lila: 0x9b59b6 }` (Keys = Choice-Values)
  - Export `buildAnnouncementModal({ customId, title = '', description = '', imageUrl = '' })` → ModalBuilder (3 Inputs: `title` Short/required/max 256, `description` Paragraph/required/max 4000, `image_url` Short/optional/max 512; bei nicht-leeren Werten `setValue(...)` für Vorbefüllung)
  - `showsModal: (interaction) => ['create', 'edit'].includes(interaction.options.getSubcommand(false))`

- [ ] **Step 1: SlashCommandBuilder auf Subcommands umbauen.**

```
create: channel (GuildText, optional), ping (Role, optional),
        farbe (String, optional, Choices: Blurple|Grün|Rot|Gelb|Orange|Lila → values blurple|gruen|rot|gelb|orange|lila)
edit:   id (String, required, setAutocomplete(true))
delete: id (String, required, setAutocomplete(true))
list:   (keine Optionen)
```

`requiredTier: 'moderator'` bleibt. Bestehende Channel-/Permission-Vorprüfungen (SendMessages, EmbedLinks, MentionEveryone bei @everyone) aus dem alten `execute` in den `create`-Zweig übernehmen — unverändert.

- [ ] **Step 2: `execute` als Subcommand-Switch.**
  - `create`: Vorprüfungen → `interaction.showModal(buildAnnouncementModal({ customId: \`announcement:modal:create:${targetChannel.id}:${pingRoleId}:${colorKey}\` }))` (`colorKey` = Choice-Value oder `blurple`).
  - `edit`: `id` parsen (`Number.parseInt`); bei `id === 0` oder NaN → `❌ Keine Announcements vorhanden.` (ephemeral). Row via `getAnnouncement` laden; `!row` → `❌ Announcement #<id> nicht gefunden.`; `row.status === 'deleted'` → `❌ Dieses Announcement wurde bereits gelöscht.`. Sonst Modal vorbefüllt zeigen: `buildAnnouncementModal({ customId: \`announcement:modal:edit:${row.id}\`, title: row.title, description: row.description, imageUrl: row.image_url ?? '' })`. WICHTIG: kein `await`-Defer davor — `showsModal` deckt create UND edit ab; die DB-Query vor `showModal()` ist ok (<3s-Fenster).
  - `delete`/`list`: laufen über den normalen Auto-Defer (Implementierung in Task 5; hier vorerst `return interaction.reply({ content: '⏳ Noch nicht implementiert.', flags: MessageFlags.Ephemeral })` als Platzhalter, wird in Task 5 ersetzt).
- [ ] **Step 3: `autocomplete(interaction)` implementieren** (für edit + delete identisch): `listRecent(interaction.guildId, 25)` → Choices `{ name: \`#${r.id} · ${truncate(r.title, 60)} · vor ${…}\`, value: String(r.id) }`; Fokus-Eingabe (`interaction.options.getFocused()`) case-insensitiv gegen Titel filtern; Leerfall → `[{ name: 'Keine Announcements gefunden', value: '0' }]`. Fehler → `interaction.respond([]).catch(() => {})`. Name-Format: Datum als `TT.MM.` aus `created_at`; Discord-Limit 100 Zeichen pro Choice-Name beachten (Titel auf 60 kürzen).
- [ ] **Step 4: Exports ergänzen** — `module.exports = { data, requiredTier, showsModal, execute, autocomplete, COLORS, buildAnnouncementModal }`.
- [ ] **Step 5: Verifizieren** — `node --check src/commands/announcement.js`; `node -e "const c=require('./src/commands/announcement'); console.log(c.data.toJSON().options.map(o=>o.name).join(','))"` → `create,edit,delete,list`. `node tests/smoke/modlog.js` als Canary.
- [ ] **Step 6: Commit** — `git commit -m "feat: announcement subcommands with color choice and autocomplete"`

---

### Task 3: Create-Flow mit Vorschau (Sessions, Buttons, Posten) + non-DB-Test

**Files:**
- Modify: `src/interactions/announcement.js` (Umbau; bestehendes Modal-Handling ersetzen)
- Test: `tests/smoke/announcement_flow.js`

**Interfaces:**
- Consumes: `COLORS`, `buildAnnouncementModal` (Task 2), `announcements.createAnnouncement` (Task 1), `config.getModLogChannelId`, `perms.requireTier`.
- Produces (Task 4/5 bauen darauf auf):
  - Session-Store: `previewSessions` Map `nonce → { mode: 'create'|'edit', announcementId: null|Number, targetChannelId, pingRoleId, colorKey, title, description, imageUrl, userId, expiresAt }`; TTL `PREVIEW_TTL_MS = 10 * 60 * 1000`; Sweeper `setInterval(..., 60_000).unref?.()`.
  - `buildAnnouncementEmbed({ title, description, color, imageUrl, createdAt = null, edited = false })` → EmbedBuilder: Farbe, Titel, Description, `setImage(imageUrl)` falls gesetzt, Footer `🐾 Oreo` bzw. `🐾 Oreo • bearbeitet`, `setTimestamp(createdAt ?? new Date())`.
  - Button-CustomIds: `announcement:preview:post:<nonce>`, `announcement:preview:reedit:<nonce>`, `announcement:preview:cancel:<nonce>`; Resume-Modal: `announcement:modal:resume:<nonce>`.
  - `module.exports = { dispatch, _internal: { previewSessions, buildAnnouncementEmbed, PREVIEW_TTL_MS, sweepSessions } }`.

- [ ] **Step 1: Failing non-DB-Test schreiben** — `tests/smoke/announcement_flow.js`:

```js
// Run with: node tests/smoke/announcement_flow.js  (kein MySQL nötig)
const assert = require('node:assert/strict');
const { _internal } = require('../../src/interactions/announcement');
const { COLORS, buildAnnouncementModal } = require('../../src/commands/announcement');

assert.ok(_internal, 'announcement interactions export _internal');
const { previewSessions, buildAnnouncementEmbed, PREVIEW_TTL_MS, sweepSessions } = _internal;

console.log('Running Test 1: Embed-Builder (create)...');
const e1 = buildAnnouncementEmbed({ title: 'T', description: 'D', color: COLORS.gruen, imageUrl: 'https://example.com/i.png' });
assert.equal(e1.data.title, 'T');
assert.equal(e1.data.color, COLORS.gruen);
assert.equal(e1.data.footer.text, '🐾 Oreo');
assert.equal(e1.data.image.url, 'https://example.com/i.png');
console.log('   Test 1 passed');

console.log('Running Test 2: Embed-Builder (edited: Footer-Marker + Original-Timestamp)...');
const orig = new Date('2026-01-01T12:00:00Z');
const e2 = buildAnnouncementEmbed({ title: 'T', description: 'D', color: COLORS.blurple, imageUrl: null, createdAt: orig, edited: true });
assert.equal(e2.data.footer.text, '🐾 Oreo • bearbeitet');
assert.equal(new Date(e2.data.timestamp).getTime(), orig.getTime());
assert.equal(e2.data.image, undefined, 'no image field when imageUrl null');
console.log('   Test 2 passed');

console.log('Running Test 3: Session-TTL-Sweeper...');
previewSessions.clear();
previewSessions.set('fresh', { expiresAt: Date.now() + PREVIEW_TTL_MS });
previewSessions.set('stale', { expiresAt: Date.now() - 1 });
sweepSessions();
assert.ok(previewSessions.has('fresh') && !previewSessions.has('stale'), 'sweeper removes only expired');
previewSessions.clear();
console.log('   Test 3 passed');

console.log('Running Test 4: Modal-Vorbefüllung...');
const m = buildAnnouncementModal({ customId: 'announcement:modal:edit:5', title: 'Alt', description: 'AltD', imageUrl: 'https://x.de/a.png' });
const rows = m.toJSON().components;
assert.equal(m.toJSON().custom_id, 'announcement:modal:edit:5');
assert.equal(rows[0].components[0].value, 'Alt');
assert.equal(rows[2].components[0].value, 'https://x.de/a.png');
console.log('   Test 4 passed');

console.log('OK — announcement flow smoke test passed');
```

- [ ] **Step 2: Test laufen lassen → FAIL** (`_internal` undefined).
- [ ] **Step 3: Interactions-Umbau implementieren.** Dispatch-Grammatik (`parts = customId.split(':')`):
  - `modal` + `isModalSubmit()`: `parts[2]` = `create` → Session anlegen aus Modal-Feldern + CustomId-Teilen; `edit` → DB-Row laden (`getAnnouncement`), Session mit `mode:'edit'`, `announcementId`, `targetChannelId=row.channel_id`, `pingRoleId=row.ping_role_id ?? 'none'`, `colorKey` aus `row.color` rückgemappt (Fallback `blurple`); `resume` → bestehende Session (`parts[3]`=nonce) mit neuen Feldwerten aktualisieren. Danach für alle drei: **Vorschau ephemeral rendern**.
  - Bild-URL-Validierung beim Modal-Submit: leer → `null`; sonst muss `/^https:\/\/\S+$/i` matchen, sonst Vorschau OHNE Bild + Warnzeile `⚠️ Die Bild-URL ist ungültig (muss mit https:// beginnen) — sie wird ignoriert. Öffne ✏️ Bearbeiten, um sie zu korrigieren.` (`imageUrl` in Session auf null).
  - Vorschau-Reply: `content` = Hinweiszeile `Vorschau — Ziel: <#channelId>` + bei Ping ` · Ping: <@&id>/@everyone` (+ ggf. Bild-Warnung), `embeds: [buildAnnouncementEmbed(...)]`, Buttons: `✅ Posten` (bzw. `✅ Übernehmen` bei mode=edit, Style Success), `✏️ Bearbeiten` (Secondary), `❌ Abbrechen` (Danger); `flags: MessageFlags.Ephemeral`. Modal-Submits sind NICHT auto-deferred (index.js deferred nur ChatInput) — direkter `interaction.reply` ist hier korrekt; prüfen wie captcha.js Modal-/Button-Replies handhabt und angleichen.
  - Session-Nonce: `interaction.id` des ERSTEN Modal-Submits; bei `resume` bleibt der alte Nonce.
  - Buttons (`preview`): Session laden; fehlt/abgelaufen → `interaction.update({ content: '⏳ Diese Vorschau ist abgelaufen — starte neu mit /announcement.', embeds: [], components: [] })`. `session.userId !== interaction.user.id` → ephemeral `❌ Diese Vorschau gehört zu jemand anderem.` (via `interaction.reply`, Session unangetastet).
    - `cancel`: Session löschen, `interaction.update({ content: '✅ Abgebrochen — nichts wurde gepostet.', embeds: [], components: [] })`.
    - `reedit`: `interaction.showModal(buildAnnouncementModal({ customId: \`announcement:modal:resume:${nonce}\`, ...sessionFelder }))` — Button-Interaktionen können Modals zeigen; danach `return true`.
    - `post` (mode=create in diesem Task): Channel re-fetchen + Bot-Perms re-validieren (bestehende Logik aus dem alten `handleModalSubmit` übernehmen: SendMessages/EmbedLinks/MentionEveryone, allowedMentions-Aufbau) → `targetChannel.send(payload)` → `createAnnouncement(...)` (bei DB-Fehler: `console.error` + Erfolgstext mit Zusatz `⚠️ Gepostet, aber NICHT in der Verwaltung gespeichert (Datenbankfehler) — Bearbeiten/Löschen über den Bot ist für dieses Announcement nicht möglich.`) → Session löschen → `interaction.update({ content: \`✅ Announcement gepostet: ${messageUrl}\`, embeds: [], components: [] })` → Mod-Log-Embed (bestehendes „📢 Announcement"-Format aus dem alten Code übernehmen, fail-soft).
  - Tier-Check am Anfang jedes Handlers wie bisher: `if (!(await perms.requireTier(interaction, 'moderator'))) return true;`.
- [ ] **Step 4: Tests** — `node tests/smoke/announcement_flow.js` → `OK`; `node --check` auf beide Dateien; `node tests/smoke/modlog.js`, `node tests/smoke/duration.js` als Canaries.
- [ ] **Step 5: Commit** — `git commit -m "feat: announcement preview flow with post/reedit/cancel buttons"`

---

### Task 4: Edit-Flow (Anwenden auf Original-Message, Diff-Modlog)

**Files:**
- Modify: `src/interactions/announcement.js` (post-Handler um mode=edit erweitern)
- Test: `tests/smoke/announcement_flow.js` (Assertions ergänzen, falls sinnvoll — Embed-Marker ist bereits abgedeckt)

**Interfaces:**
- Consumes: Session-Store (Task 3), `announcements.getAnnouncement/updateAnnouncement` (Task 1).

- [ ] **Step 1: `post`-Handler für `mode === 'edit'`:** Row erneut laden (`getAnnouncement`); `!row || row.status === 'deleted'` → `❌ Dieses Announcement existiert nicht mehr in der Verwaltung.` (update, Buttons weg). Channel fetchen, `channel.messages.fetch(row.message_id)`:
  - Message weg → `interaction.update({ content: '❌ Die Original-Nachricht existiert nicht mehr (manuell gelöscht?).', embeds: [], components: [Row mit Button 'Eintrag als gelöscht markieren' → customId \`announcement:delconfirm:yes:${row.id}\`] })` — der Task-5-Handler übernimmt das Soft-Delete (Task 5 implementiert ihn; bis dahin greift der `console.warn`-Fallback im Dispatch).
  - Message da → `message.edit({ embeds: [buildAnnouncementEmbed({ title, description, color: row.color ?? COLORS.blurple, imageUrl, createdAt: new Date(row.created_at), edited: true })] })` — KEIN `content` im Edit-Payload (Ping-Zeile bleibt unverändert erhalten). → `updateAnnouncement(guildId, row.id, { title, description, imageUrl, editedBy: interaction.user.id })` (DB-Fehler: fail-soft mit `⚠️ Nachricht editiert, aber die Verwaltung konnte nicht aktualisiert werden (Datenbankfehler).`) → Session löschen → `✅ Announcement bearbeitet: <messageUrl>`.
- [ ] **Step 2: Edit-Modlog:** Embed „✏️ Announcement bearbeitet", Farbe 0x5865f2, Felder: Moderator (`<@id>`), Channel, Link, `Titel` alt→neu und `Beschreibung` alt→neu — jeweils NUR wenn geändert, Werte auf 300 Zeichen gekürzt (`alt … → neu …` als zwei Zeilen `**Alt:** … \n **Neu:** …`). Fail-soft wie gehabt.
- [ ] **Step 3: Tests** — `node tests/smoke/announcement_flow.js`, `node --check`, Canaries wie Task 3.
- [ ] **Step 4: Commit** — `git commit -m "feat: announcement edit applies to original message with edit marker and diff modlog"`

---

### Task 5: Delete-Flow + List + Orphan-Cleanup

**Files:**
- Modify: `src/commands/announcement.js` (delete/list-Platzhalter ersetzen)
- Modify: `src/interactions/announcement.js` (delconfirm-Handler)

**Interfaces:**
- Consumes: `announcements.getAnnouncement/markDeleted/listRecent`; Button-CustomIds `announcement:delconfirm:<yes|no>:<announcementId>`.

- [ ] **Step 1: `delete`-Subcommand (Command, läuft auto-deferred):** id parsen (0/NaN → `❌ Keine Announcements vorhanden.`); Row laden; `!row` → `❌ Announcement #<id> nicht gefunden.`; `status='deleted'` → `❌ Bereits gelöscht.`. Sonst ephemerale Rückfrage: Kurz-Embed (`buildAnnouncementEmbed` mit Row-Daten, `edited: !!row.edited_at`) + `content: '⚠️ Dieses Announcement endgültig löschen? Die Nachricht wird entfernt.'` + Buttons `🗑️ Endgültig löschen` (Danger, `announcement:delconfirm:yes:<id>`) / `Abbrechen` (Secondary, `announcement:delconfirm:no:<id>`).
- [ ] **Step 2: `delconfirm`-Handler (Interactions):** Tier-Check. `no` → `interaction.update({ content: '✅ Abgebrochen.', embeds: [], components: [] })`. `yes` → Row laden (weg/deleted → entsprechende Meldung); Nachricht best-effort löschen: `channel.messages.delete(row.message_id).catch(() => null)` (Channel-Fetch ebenfalls `catch(() => null)` — Orphan-Fall: Nachricht existiert nicht mehr, ist ok) → `markDeleted` → `interaction.update({ content: \`🗑️ Announcement #${row.id} („${truncate(row.title, 60)}") gelöscht.\`, embeds: [], components: [] })` → Modlog „🗑️ Announcement gelöscht" (Moderator, Titel, Ex-Channel `<#id>`, fail-soft). Damit deckt derselbe Handler den Orphan-Cleanup-Button aus Task 4 ab.
- [ ] **Step 3: `list`-Subcommand:** `listRecent(guildId, 10)`; leer → `Noch keine Announcements gespeichert.`; sonst Embed „📢 Announcements (letzte 10)", pro Row eine Zeile: `#id · **Titel(60)** · <#channel> · <@author> · TT.MM.JJJJ · [Link](https://discord.com/channels/<guild>/<channel>/<message>)`, Footer `🐾 Oreo`. Ephemeral (auto-defer reicht, `interaction.reply` = editReply via Patch).
- [ ] **Step 4: Tests** — `node --check` beide Dateien; `node tests/smoke/announcement_flow.js`; `node -e "require('./src/commands/announcement')"`.
- [ ] **Step 5: Commit** — `git commit -m "feat: announcement delete with confirmation and list overview"`

---

### Task 6: CLAUDE.md + Testbatterie + Merge-Vorbereitung

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: CLAUDE.md aktualisieren** (Maintenance-Rule): Layout-Liste + `src/announcements.js`, neue Tabelle `announcements` (Soft-Delete via status), CustomId-Familie `announcement:modal|preview|delconfirm:*`, Vorschau-Sessions in-memory (10-Min-TTL, gehen bei Restart verloren — dokumentierte Design-Entscheidung), `showsModal` von announcement ist jetzt eine Funktion (create/edit).
- [ ] **Step 2: Volle verfügbare Testbatterie** — `node --check` auf alle geänderten Dateien; alle non-DB-Suiten (`duration`, `channel_hopping`, `modlog`, `join_role`, `server_logging`, `voice_rec`, `announcement_flow`); DB-Suiten als „CI validiert" vermerken.
- [ ] **Step 3: Commit** — `git commit -m "docs: document announcement lifecycle in CLAUDE.md"`
- [ ] **Step 4: Merge-Entscheidung** — superpowers:finishing-a-development-branch: Merge `feat/announcement-lifecycle` → `main` (ff), Push triggert CI (validiert die neue DB-Suite gegen MySQL 8.4) + Deploy. Command-Neuregistrierung passiert beim Bot-Start automatisch (deployCommands).

---

## Explizit NICHT in diesem Plan

Geplante/zeitversetzte Announcements; restart-sichere Vorschau-Drafts; Farbe/Ping nachträglich ändern; Kontextmenü-Commands.
