# Oreo Verbesserungs-Roadmap (Stand 2026-07-09)

> Priorisierte Gesamtübersicht aller offenen Verbesserungen aus den Review-Runden 2026-07-06 bis 2026-07-08. Kein SDD-Ausführungsplan — pro Welle wird bei Umsetzung ein eigener Implementierungsplan erstellt (Welle 1 hat bereits fertige Task-Specs im alten Plan). Quellen: CLAUDE.md Known Issues, SDD-Ledger-Minors, Final-Review-Follow-ups, alter Audit-Plan Tasks 10–15.

**Empfohlene Reihenfolge: Welle 0 (Quick Wins, ~1 Session) → Welle 1 (Sicherheit) → Welle 2 (Robustheit) → Welle 3 (Vereinfachung) → Welle 4 (Features, optional).**

---

## Welle 0 — Quick Wins: Developer Experience + Kleinigkeiten (~1 Session)

Diese Punkte kosten fast nichts und beschleunigen alles Weitere:

### 0.1 Lokale Dev-Datenbank (größter Einzelhebel!)
`docker-compose.dev.yml` mit einem MySQL-8.4-Service (gleiche Creds wie CI) + npm-Script `npm run test:local` das den Container startet und `npm test` fährt. **Warum:** Beide großen Arbeitsrunden litten massiv darunter, dass 9 von 16 Test-Suiten lokal nie liefen — der rote Main-Commit am 2026-07-08 (Config-Cache vs. Test-Fixtures) wäre lokal aufgefallen, bevor er auf `main` landete. Aufwand: klein.

### 0.2 CI auch für Branches/PRs
`deploy.yml` um einen `pull_request`/`push: branches-ignore: main`-Trigger für den Test-Job erweitern (Deploy bleibt main-only). **Warum:** Feature-Branches werden dann VOR dem Merge gegen echtes MySQL validiert — der Merge auf main kann nie mehr rot werden. Aufwand: winzig.

### 0.3 Kleinst-Fixes aus den Reviews (zusammen ~30 min)
- `delconfirm`-Buttons: synchroner Claim-Flag wie beim Preview-Post (verhindert doppelte Modlog-Zeile bei Doppelklick).
- `try/finally` um das `posting`-Flag in `handlePostCreate`/`handlePostEdit` (macht den Claim wasserdicht gegen unerwartete Throws).
- Config-Cache: In-Flight-Promise-Dedup (Thundering-Herd beim kalten 30s-Fenster).
- Test-Mocks in `join_role.js`/`server_logging.js`: `roles.cache.find` ergänzen (beseitigt die gefangenen TypeError-Stacktraces im CI-Log).
- `truncateForDiff` in `_internal` exportieren + 2 Assertions im Flow-Test.

---

## Welle 1 — Sicherheit & Privacy (alter Plan, Tasks 10–15 — Specs FERTIG)

Die kritischsten offenen Punkte. Vollständige Schritt-für-Schritt-Specs existieren bereits in `docs/superpowers/plans/2026-07-06-audit-bugfixes.md` — direkt SDD-ausführbar, kein neues Planning nötig.

| # | Item | Warum wichtig | Alter Task |
|---|---|---|---|
| 1.1 | **Captcha-Antwort steht im Button-customId** — Selfbots lösen das Captcha automatisch, ohne es zu sehen | Hebelt den kompletten Raid-Schutz aus | Task 10 |
| 1.2 | **Verifizierungs-Deadlines nur als setTimeout** — Bot-Restart vergisst offene Verifizierungen; wer gelöst hat, kann trotzdem gekickt werden | False-Kicks + Restart-Lücke | Task 11 |
| 1.3 | **Ein Verify-Channel pro Joiner** — eine Raid-Welle erzeugt Channel-Spam und pingt @here → Self-DoS | Anti-Raid schützt derzeit nicht vor sich selbst | Task 12 |
| 1.4 | **Speech streamt Audio an Google STT, auch wenn voice_rec deaktiviert ist** (Check erst NACH Transkription) | Privacy-Problem, potenziell DSGVO-relevant | Task 13 |
| 1.5 | **Sprachbefehle per Substring-Match** — „Oreo Banane" triggert „ban"; destruktive Aktionen ohne Bestätigung | False-Positive-Moderation | Task 14 |
| 1.6 | **`guild_users.level` fehlt im Schema** — Tier-Checks funktionieren nur auf der geteilten Ramen-DB | Standalone-Deployments kaputt | Task 15 |

Aufwand gesamt: ~1–2 Sessions. Empfehlung: als Nächstes angehen — es ist der einzige Block mit echten Sicherheitslücken.

---

## Welle 2 — Robustheit & Korrektheit (braucht kurzes Design, dann Plan)

### 2.1 Escalation-Race (PLAUSIBLE, dokumentiert)
Zwei gleichzeitige Warns lesen denselben Count → Eskalationsschwelle feuert doppelt oder wird übersprungen (Exact-Match-Lookup). **Fix-Richtung:** `getRuleForThreshold` auf `warn_threshold <= count AND warn_threshold > lastHandledCount` umstellen ODER Transaktion mit `SELECT … FOR UPDATE` auf der Guild-User-Zeile um Insert+Count+Eskalation. Zweiteres ist sauberer, braucht aber eine kleine Design-Entscheidung (Lock-Granularität). Aufwand: mittel.

### 2.2 `MODLOG_CHANNEL_ID`-Env-Fallback entfernen
Der globale Fallback schickt Mod-Logs fremder Guilds in EINEN Channel — Cross-Guild-Datenleck, sobald der Bot auf >1 Server läuft. **Fix:** Fallback streichen, Migration: beim Start einmalig loggen welche Guilds keinen eigenen Modlog haben. Achtung: bewusste Verhaltensänderung, vorher kurz absprechen. Aufwand: klein.

### 2.3 `/lockdown` + `/unlock` decken Threads nicht ab
Threads behalten eigene Send-Rechte → Lockdown ist umgehbar. **Fix:** aktive Threads des Channels mitsperren (`thread.setLocked` / SendMessagesInThreads-Overwrite). Aufwand: klein-mittel.

### 2.4 Obfuscation-False-Positives
Die Leet-Normalisierung matcht legitime Wörter. **Fix-Richtung:** Wortgrenzen-Matching nach Normalisierung + optionale Guild-Whitelist (`automod_exemptions` existiert schon — prüfen ob nutzbar). Braucht kurze Analyse realer False-Positives. Aufwand: mittel.

---

## Welle 3 — Vereinfachung & Konsolidierung (Code-Qualität, kein Verhalten)

Nach Nutzen/Aufwand sortiert:

### 3.1 config.js kollabieren (~800 → ~80 Zeilen)
75 fast identische Getter/Setter → ein `getGuildConfig(guildId)` (gecachte Row, Caller lesen Felder) + generisches `set(guildId, column, value)` mit Spalten-Whitelist. Cache-Mechanik bleibt exakt wie heute. **Warum:** jede neue Config-Option kostet heute 2 Boilerplate-Funktionen + Edit an einem 40-Spalten-SELECT; Hot-Path-Handler rufen 5–15 Getter statt einmal die Row zu lesen. **Risiko:** mechanisch, aber ~150 Call-Sites — nur mit grep-basierter Vollständigkeitsprüfung + kompletter Testbatterie. Aufwand: mittel-groß, lohnt sich.

### 3.2 Monkey-Patch-Ablösung (`interaction.reply` → `editReply`)
Der Patch funktioniert, ist aber die größte dokumentierte Falle im Codebase (CLAUDE.md Invarianten 1–2 existieren nur seinetwegen; Collector-/Test-Kontexte bekommen ungepatschte Interactions). **Fix-Richtung:** exportierter `respond(interaction, payload)`-Helper, Commands stellen schrittweise um, Patch fällt am Ende. **Warnung:** hohes Churn-Risiko (~30 Commands), nur als eigenes, sorgfältig reviewtes Projekt — nicht nebenbei. Aufwand: groß. Priorität: niedrig, solange der Patch dokumentiert ist.

### 3.3 Kleine Konvergenzen (je ~30–60 min)
- DM-Embed-Helper für warn/ban/kick (3× dupliziert, Kick nutzt versehentlich die Softban-Farbe).
- `cleanup`/`lockdown`/`slowmode`/`unlock` auf `sendModLog` umstellen (letzte 4 Inline-Modlogs).
- messageCreate: die 2 verbliebenen Inline-Modlog-Blöcke auf den lokalen `postModLogWarning`-Helper bzw. `sendModLog`-Muster ziehen.
- `validateModTarget`: optionale Fail-Fast-Reihenfolge (self/bot-Check vor dem Fetch) — kosmetisch.

---

## Welle 4 — Features & UX (optional, jeweils Brainstorming zuerst)

Ideen, keine Zusagen — jede braucht eine kurze Design-Runde:

- **Geplante Announcements** (`/announcement schedule`): natürlicher nächster Schritt auf der neuen `announcements`-Tabelle + Background-Loop; Vorschau-Flow existiert schon.
- **Announcement: Farbe/Ping nachträglich ändern** (bewusst aus v1 ausgeklammert).
- **Restart-sichere Announcement-Drafts** (bewusst ausgeklammert — nur wenn der 10-Min-TTL-Verlust in der Praxis nervt).
- **`/modhistory`/`/warnings` Pagination** mit Buttons statt fester Limits.
- **Audit-Log für Config-Änderungen** (`/config`-Änderungen ins Mod-Log — wer hat was umgestellt).
- **Dashboard/Statistiken** (`/stats` ausbauen: Moderations-Trends, Automod-Hit-Raten — Daten liegen alle in `infractions`).

---

## Bewusst NICHT auf der Roadmap

- ESM/TypeScript-Migration, Framework-Wechsel (Churn ohne Nutzerwert).
- Restart-sichere Preview-Drafts (dokumentierte Design-Entscheidung).
- `/untimeout` auf `validateModTarget` zwingen (bewusst nicht konvergiert — eigene Guard-Reihenfolge).

## Vorgehen bei Umsetzung

Pro Welle: `superpowers:writing-plans` → SDD-Ausführung (Subagent pro Task + Review) → Feature-Branch → Final-Review → Merge auf `main` (CI validiert + deployt). Welle 1 überspringt das Planning (Specs fertig). CLAUDE.md nach jeder Welle aktualisieren.

---

## Nachträge aus Welle 1 (2026-07-09, Follow-ups)

- **captcha markVerified DB-Fehler-Residual:** wirft der `markVerified`-DELETE beim Lösen selbst (transienter DB-Fehler, gefangen+geloggt), behält der User verifizierte Rollen, aber die pending-Row bleibt → theoretischer Deadline-Kick binnen 15 min. Nur DB-Fehler-Randfall. Fix-Richtung: bei markVerified-Fehler die Rollenvergabe abbrechen oder einen zweiten Löschversuch im Sweep.
- **captcha pick-Branch ohne Doppelklick-Claim** (vorbestehend): schneller Doppelklick feuert idempotente Rollenarbeit / no-op-zweiten-Kick. Geringe Auswirkung. Claim analog voiceconfirm/announcement nachrüsten.
- **confirmed-mute createCase-Fehler wird geloggt, nicht revertiert** (voiceconfirm.js, bewusst — Voice-UX hat keinen Ort für ein Undo). Nur falls es in der Praxis auffällt.
