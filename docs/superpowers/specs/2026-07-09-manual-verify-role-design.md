# Manuelle Verified-Rolle = verifiziert — Design Spec

**Datum:** 2026-07-09
**Status:** Approved (Design)
**Bot:** Oreo

## Ziel

Wenn ein Moderator einem Mitglied **manuell** eine als Verify festgelegte Rolle
(`verified_role_ids`) gibt, soll Oreo das Mitglied wie ein per-Captcha verifiziertes
behandeln — d. h. es **nicht** nach Ablauf der Verify-Deadline kicken und den
Unverified-Zustand angleichen.

Hintergrund: Aktuell löscht nur der Captcha-Erfolg die `pending_verifications`-Deadline
(Invariante 15). Bekommt jemand die Verified-Rolle manuell, bleibt die Deadline bestehen
und der Background-Sweep (`background.js`) kickt ihn trotz Rolle.

## Nicht im Scope (bewusst)

- **Bots:** brauchen keine Änderung. `guildMemberAdd.js` steigt bereits in Zeile 17
  früh aus (`if (member.user.bot) return;`) — Bots werden nie für Verify getrackt oder
  gekickt. Es wird **keine** Auto-Verified-Rolle für Bots vergeben (Design-Entscheidung).
- **Kein Modlog-Eintrag** beim manuellen Verify (der Captcha-Erfolg schreibt auch keinen).

## Verhalten

Beim Erkennen, dass einem Nicht-Bot-Mitglied **neu** eine Verified-Rolle zugewiesen wurde:

1. `verifications.markVerified(guildId, userId)` — löscht die `pending_verifications`-Zeile
   (kein Deadline-Kick). Idempotent: no-op, wenn keine Zeile existiert. Exakt derselbe
   Aufruf wie im Captcha-Erfolgspfad.
2. Alle konfigurierten **Unverified-Rollen** (`unverified_role_ids`) vom Mitglied entfernen
   (best-effort, `.catch`), damit der Zustand konsistent ist (kein „verified + unverified").

## Architektur

**Neuer Event-Handler:** `src/events/guildMemberUpdate.js`
- Export: `{ name: Events.GuildMemberUpdate, execute }` — wird von `loadEvents.js`
  automatisch geladen und in `.catch()` gewrappt. **Kein `index.js`-Eingriff.**
- Benötigte Intent `GatewayIntentBits.GuildMembers` ist bereits aktiv.

**Reine Entscheidungslogik (testbar, ohne DB/Discord):**
`_internal.decideVerification({ isBot, oldRoleIds, newRoleIds, verifiedRoleIds, unverifiedRoleIds, oldPartial })`
→ `{ verify: boolean, removeUnverified: string[] }`

Regeln:
- `isBot` → `{ verify: false, removeUnverified: [] }`.
- `hasVerifiedNow` = `newRoleIds` ∩ `verifiedRoleIds` nicht leer. Wenn nein → keine Aktion.
- `hadVerifiedBefore` = `!oldPartial && (oldRoleIds ∩ verifiedRoleIds nicht leer)`.
  Wenn ja → keine Aktion (Rolle war schon da, nichts Neues).
- sonst → `{ verify: true, removeUnverified: unverifiedRoleIds ∩ newRoleIds }`.
- Bei `oldPartial` (alter Member nicht gecacht) wird angeglichen (idempotent, harmlos).

**`execute(oldMember, newMember)`** verdrahtet:
- baut `oldRoleIds`/`newRoleIds` aus `*.roles.cache`, `oldPartial = oldMember.partial === true`,
- liest `config.getVerifiedRoleIds` / `config.getUnverifiedRoleIds`,
- ruft `decideVerification` auf,
- bei `verify`: `verifications.markVerified(...)` + für jede `removeUnverified`-Rolle
  `member.roles.remove(role, 'Oreo: Manuell verifiziert')` (best-effort).
- Frühabbruch, wenn `verifiedRoleIds.length === 0` (Feature nicht konfiguriert).

## Kein Loop

Das Entfernen der Unverified-Rolle löst erneut `GuildMemberUpdate` aus, aber dabei ist
keine Verified-Rolle *neu* dazugekommen (`hadVerifiedBefore` = true) → `decideVerification`
liefert `verify: false`. Kein Endlos-Loop.

## Testing

`tests/smoke/manual_verify.js` (ohne DB) — testet ausschließlich die reine
`decideVerification`:
- Verified-Rolle neu vorhanden, vorher nicht → `verify: true`, `removeUnverified` enthält die
  vorhandene Unverified-Rolle.
- keine Verified-Rolle im neuen Set → `verify: false`.
- `isBot: true` → `verify: false`.
- Verified-Rolle war schon vorher da (`oldPartial: false`) → `verify: false`.
- `oldPartial: true` mit Verified-Rolle jetzt → `verify: true` (Angleichung).
- `removeUnverified` enthält nur Unverified-Rollen, die der Member tatsächlich hat.

## Betroffene Dateien

- Neu: `src/events/guildMemberUpdate.js`
- Neu: `tests/smoke/manual_verify.js`
- Danach: `CLAUDE.md` aktualisieren (neue Invariante + Layout-/Testing-Zeile), gemäß Maintenance-Rule.
