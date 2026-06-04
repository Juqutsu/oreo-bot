> [!abstract] Was ist Oreo? Oreo ist der **Wachhund des Home Servers** – Maskottchen und Sicherheitsbeauftragter in einem. Er kümmert sich um alles rund um **Moderation, User-Management und Sicherheit**. Bellt, wenn was faul ist. 🦴

> [!info] Bigger Picture Oreo ist **einer von mehreren Bots** auf dem Server. Jeder Bot übernimmt einen klar abgegrenzten Aufgabenbereich. Oreo = Security & Moderation. Andere Bots (Fun, Musik, Utility, …) kommen separat – Aufgaben bleiben sauber getrennt.

---

## 🎯 Aufgabenbereich

Oreo ist **ausschließlich** für Security & Moderation zuständig:

- 🛡️ Schutz des Servers vor Spam, Scams und Störern
- ⚖️ Moderationswerkzeuge fürs Team (Ban, Timeout, Warn)
- 📋 Report-System für die Community
- 🪶 Nachvollziehbarkeit wichtiger Moderationsaktionen

> [!note] Bewusst NICHT Oreos Job Fun-Commands, Musik, Leveling, Willkommensnachrichten etc. → das machen andere Bots.

---

## 🛠️ Moderationswerkzeuge

Klassische Mod-Tools fürs Team, sauber und nachvollziehbar.

> [!example] Funktionen
>
> - **Ban / Unban** – dauerhaft oder zeitlich begrenzt (Temp-Ban läuft automatisch ab)
> - **Timeout / Untimeout** – stummschalten auf Zeit
> - **Warn / Warn entfernen** – Verwarnungen mit Begründung
> - **Notiz** – interne Anmerkung zu einem User, ohne Strafe

### ⚠️ Warn-Eskalation

Verwarnungen summieren sich und lösen automatisch Konsequenzen aus – konfigurierbar, z. B.:

| Warns | Konsequenz              |
| ----- | ----------------------- |
| 3     | Timeout (1 h)           |
| 5     | Timeout (24 h)          |
| 7     | Ban-Vorschlag an Admins |

> [!tip] Maskottchen-Touch Oreo „meldet" Eskalationen in Charakter: _🐕 „Oreo hat dreimal gebellt – Timeout für @User."_ Funktion bleibt sachlich, Ton wird sympathischer.

---

## 📋 Report-System

Die Community kann Regelverstöße selbst melden – das Mod-Team bearbeitet sie zentral.

> [!example] Ablauf
>
> 1. User meldet jemanden (Formular mit Grund, optional Nachweis/Link)
> 2. Report landet im **Report-Channel** als übersichtliche Meldung
> 3. Team ab Rolle **Supporter** bearbeitet ihn direkt per Knopfdruck
> 4. Report bekommt einen Status, damit man sieht was offen ist

### Report-Status

- 🟡 **Offen** – noch niemand dran
- 🔵 **In Bearbeitung** – ein Supporter hat übernommen (Name sichtbar → keine Doppelarbeit)
- 🟢 **Erledigt** – Aktion durchgeführt
- 🔴 **Abgelehnt** – kein Verstoß / Spam-Report

### Knöpfe am Report

- **Übernehmen** – Supporter klinkt sich ein
- **Aktion** – direkt Warn / Timeout / Ban am gemeldeten User
- **Erledigt / Ablehnen** – Report schließen

> [!tip] Reporter-Schutz Wer gemeldet hat, ist nur fürs Mod-Team sichtbar – nicht öffentlich.

---

## 🤖 Auto-Moderation

Oreo behält den Chat im Auge und reagiert automatisch.

> [!example] Überwacht
>
> - **Spam** – dieselbe Nachricht mehrfach, zu schnelles Posten
> - **Mass-Mentions** – User der zu viele Leute/Rollen auf einmal pingt
> - **Link-Spam / Invite-Spam** – ungefragte Werbung, fremde Server-Invites

> [!info] Reaktion Auto-Mod nutzt dieselbe Eskalationslogik wie manuelle Warns: erst löschen + verwarnen, bei Wiederholung Timeout. Jede Auto-Aktion ist als solche erkennbar.

> [!question] Offene Frage Sollen bestimmte Channels / Rollen von Auto-Mod **ausgenommen** sein (z. B. ein „Werbung erlaubt"-Channel, oder Staff generell)? Whitelist sinnvoll?

---

## 📜 Logging

Wichtige Moderationsaktionen werden festgehalten – nicht alles, aber das Relevante.

> [!example] Was geloggt wird
>
> - **Mod-Log-Channel:** jede Strafe (Ban/Timeout/Warn) mit Mod, Ziel, Grund, Zeit
> - Getrennt vom Report-Channel, damit beides übersichtlich bleibt
> - Farbcodierung nach Schwere (rot = Ban, orange = Timeout, gelb = Warn)

> [!note] Bewusst minimal Kein Vollprotokoll von allem (keine Nachrichten-Logs, keine Voice-Logs). Nur das, was fürs Nachvollziehen von Moderationsentscheidungen zählt.

---

## 👥 Berechtigungen

Gestaffelte Rechte nach Team-Rolle:

| Rolle         | Darf                                                |
| ------------- | --------------------------------------------------- |
| **User**      | Reports erstellen, eigene Warns sehen               |
| **Supporter** | Reports bearbeiten, Warn, Timeout                   |
| **Moderator** | + Ban / Unban, Warns entfernen                      |
| **Admin**     | + Einstellungen, Eskalationsregeln, Auto-Mod-Config |

> [!warning] Wichtige Regel Niemand darf jemanden mit **gleicher oder höherer Rolle** moderieren. Schützt das Team vor sich selbst (und vor kompromittierten Accounts).

---

## ✨ Maskottchen-Persönlichkeit

Oreo ist ein Hund – das darf man merken, ohne dass es albern wird.

> [!example] Beispiele
>
> - Beim Start: _🐕 „Oreo ist wach und schnüffelt herum."_
> - Bei erkanntem Spam: _🦴 „Oreo wittert Spam und hat aufgeräumt."_
> - Bei Ban: nüchtern, aber mit Signatur-Pfötchen 🐾
>
> Optional pro Server an-/abschaltbar, falls es mal rein sachlich sein soll.

---

## 🔭 Mögliche Erweiterungen (später)

Ideen für Oreo v2 – wenn die Basis steht:

- [ ] **Raid-Schutz** – Lockdown bei Join-Wellen, Alarm ans Team
- [ ] **Anti-Phishing** – bekannte Scam-Links automatisch löschen
- [x] **Verifizierung** – Button/Captcha für neue User vor Schreibrechten
- [x] **Account-Age-Check** – brandneue Accounts beim Join flaggen
- [ ] **Verdächtige-Aktivität-Alerts** – Massen-DMs, schnelle Rollenwechsel
- [ ] **Statistiken** – Reports/Woche, häufigste Gründe, aktivste Mods

---

## 🔗 Links & Kontext

- [[Home Server]]
- Bot-Familie: Oreo (Security/Mod) · _weitere Bots TBD_
