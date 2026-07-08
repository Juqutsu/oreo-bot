# Announcement-Verbesserungen — Design

**Datum:** 2026-07-08 · **Status:** approved · **Feature-Owner:** Lukas

## Ziel

Das `/announcement`-Feature von "einmalig posten" zu einem verwalteten Lebenszyklus ausbauen: **Vorschau vor dem Posten, Bearbeiten, Löschen, Liste** — mit klaren, nachvollziehbaren Fehlermeldungen. Kern-Feature ist das Bearbeiten bestehender Announcements.

## Entscheidungen (mit Lukas geklärt)

| Frage | Entscheidung |
|---|---|
| Auswahl beim Bearbeiten | Gespeicherte Liste + Autocomplete (DB-gestützt) |
| Scope | Vorschau, Edit, Delete, Liste, Farbe + Bild |
| Berechtigung | Jeder Moderator darf jedes Announcement bearbeiten/löschen; Attribution im Mod-Log |
| Edit-Sichtbarkeit | Dezenter Footer-Hinweis `🐾 Oreo • bearbeitet`, Embed-Timestamp bleibt Original-Zeitpunkt |
| Architektur | Subcommands + DB-Tabelle + In-Memory-Vorschau (TTL); KEINE restart-sicheren Drafts (YAGNI) |

## Commands (alle `requiredTier: 'moderator'`)

### `/announcement create [channel] [ping] [farbe]`
- Optionen wie bisher (`channel` default aktueller, `ping` Rolle inkl. @everyone) plus **`farbe`** als Choice-Option: Blurple (Default, 0x5865f2), Grün (0x57f287), Rot (0xed4245), Gelb (0xfee75c), Orange (0xe67e22), Lila (0x9b59b6). Keine freie Hex-Eingabe.
- Modal: **Titel** (Short, required, max 256), **Beschreibung** (Paragraph, required, max 4000), **Bild-URL** (Short, optional, max 512).
- Nach Submit: **ephemerale Vorschau** — das fertige Embed + Hinweiszeile (Ziel-Channel, Ping) + Buttons `✅ Posten` / `✏️ Bearbeiten` / `❌ Abbrechen`.
- Erst `✅ Posten`: Permissions re-validieren → Nachricht senden → DB-Row anlegen → Mod-Log → ephemerale Bestätigung mit Message-Link.

### `/announcement edit id:<autocomplete>`
- Autocomplete: letzte 25 mit `status='posted'` des Servers, Label `«Titel (gekürzt)» · #channel · TT.MM.`, Value = DB-id. Tier-Gate greift über den bestehenden Autocomplete-Gate in index.js.
- Ablauf: DB-Row laden → Modal **vorbefüllt** (Titel/Beschreibung/Bild-URL via `setValue`) → gleiche Vorschau wie create → `✅ Übernehmen` editiert die Original-Nachricht per `message.edit`.
- Beim Edit: Footer `🐾 Oreo • bearbeitet`, `setTimestamp(created_at)` (Original bleibt), Farbe/Ping bleiben unverändert (Edit ändert nur Modal-Felder). DB: `title/description/image_url`, `edited_at=NOW()`, `edited_by`. Mod-Log-Embed „✏️ Announcement bearbeitet" mit Moderator, Link und Alt→Neu für Titel/Beschreibung (je auf 300 Zeichen gekürzt).

### `/announcement delete id:<autocomplete>`
- Gleiches Autocomplete. Ephemerale Rückfrage mit Embed-Kurzansicht + Buttons `🗑️ Endgültig löschen` / `Abbrechen`.
- Löschen: Nachricht via `channel.messages.delete` entfernen → DB `status='deleted'` (Soft-Delete) → Mod-Log „🗑️ Announcement gelöscht" mit Moderator, Titel, Ex-Channel.

### `/announcement list`
- Letzte 10 (`status='posted'`) als ephemerales Embed: `#id · Titel · #channel · Autor · Datum · [Link]`. Leerfall: „Noch keine Announcements gespeichert."

## Datenmodell

`server/schema.sql`, neue Tabelle (Muster: `reports`):

```sql
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

Neues DAL **`src/announcements.js`** (Muster `src/reports.js`, `runner = conn ?? getPool()`):
`createAnnouncement({...})` → id · `getAnnouncement(guildId, id)` · `listRecent(guildId, limit=25)` · `updateAnnouncement(guildId, id, { title, description, imageUrl, editedBy })` · `markDeleted(guildId, id)`.
Keine Row-Caches (kein Hot-Path); Tests dürfen roh schreiben.

## Interaktions-Flow (`src/interactions/announcement.js`)

- **Vorschau-Sessions:** Map `nonce → { mode: 'create'|'edit', announcementId?, targetChannelId, pingRoleId, color, title, description, imageUrl, userId, expiresAt }`, TTL 10 min, `setInterval`-Sweeper mit `.unref?.()` (Muster `pendingPuzzles`). Nonce = `${interaction.id}` des Modal-Submits.
- **CustomIds:** `announcement:modal:<create|edit>:<channelId|annId>:<pingRoleId|none>:<color|default>` (Modal) · `announcement:preview:<post|edit|cancel>:<nonce>` (Buttons) · `announcement:delconfirm:<yes|no>:<annId>`.
- `✏️ Bearbeiten`-Button in der Vorschau öffnet das Modal erneut, vorbefüllt aus der Session (Button-Interaktionen dürfen `showModal`).
- Nur der auslösende Moderator darf die Vorschau-Buttons bedienen (`userId`-Check, sonst „❌ Diese Vorschau gehört zu jemand anderem.").
- `src/commands/announcement.js` bekommt Subcommands; `showsModal` wird Funktion: `(i) => ['create','edit'].includes(i.options.getSubcommand(false))`. delete/list laufen über den normalen Auto-Defer.
- Mod-Logs weiterhin fail-soft; wo ein `interaction`-Kontext existiert, via bestehendem `sendModLog`-Muster bzw. inline wie bisher (Announcement-Modlog hat eigenes Embed-Format, kein `buildModLogEmbed`-Action-Typ nötig).

## Fehlerbehandlung (Kernanforderung: klar & nachvollziehbar)

| Situation | Verhalten |
|---|---|
| Vorschau abgelaufen (>10 min) / Bot-Neustart | „⏳ Diese Vorschau ist abgelaufen — starte neu mit `/announcement create`." Buttons entfernen. |
| Bild-URL ungültig (kein `https://`-URL) | In der Vorschau-Phase abfangen: „❌ Die Bild-URL ist ungültig (muss mit https:// beginnen). Öffne ✏️ Bearbeiten und korrigiere sie." — Vorschau ohne Bild rendern. |
| Original-Nachricht beim Edit/Delete nicht mehr auffindbar | „❌ Die Original-Nachricht existiert nicht mehr (manuell gelöscht?)." + Button „Eintrag als gelöscht markieren" → Soft-Delete. |
| Ziel-Channel weg / Permissions fehlen beim Posten | Re-Check zum Post-Zeitpunkt (bestehendes Muster), konkrete Meldung welcher Perm fehlt. |
| Autocomplete ohne Treffer | Choice „Keine Announcements gefunden" (value `none`), Command antwortet entsprechend. |
| DB-Fehler beim Posten (Row kann nicht geschrieben werden) | Announcement wurde gepostet, Row fehlt → Meldung: „⚠️ Gepostet, aber NICHT in der Verwaltung gespeichert (Datenbankfehler) — Bearbeiten/Löschen über den Bot ist für dieses Announcement nicht möglich." (Kein Auto-Delete des Posts — Announcement ist kein Punishment.) |

## Tests

- **DB-Smoke (CI):** `tests/smoke/announcements.js` — DAL-Roundtrip (create → get → listRecent → update → markDeleted; Soft-Delete verschwindet aus listRecent).
- **Non-DB:** Embed-Builder (Farben, Footer-Edit-Marker, Timestamp-Erhalt), CustomId-Parsing, Vorschau-TTL/Sweeper, userId-Gate der Buttons.
- CLAUDE.md nach Implementierung aktualisieren (Maintenance-Rule): neue Tabelle, neue CustomId-Familie, `showsModal`-Funktion.

## Außerhalb des Scopes

Geplante/zeitversetzte Announcements, restart-sichere Vorschau-Drafts, Edit der Farbe/des Pings nach dem Posten, Mehrsprachigkeit.
