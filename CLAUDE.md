# CLAUDE.md — Oreo Bot

> **MAINTENANCE RULE (always applies):** After completing any prompt/task in this repo, update this file with new information learned — new commands, changed invariants, fixed/new bugs, schema changes, config keys, deploy changes. Keep it factual and current; remove entries that become obsolete. This file is the single source of truth for working on Oreo.

## What Oreo is

German-language Discord **security & moderation bot** ("Wachhund des Home Servers") — one of several single-purpose bots on the Home Server (others handle fun/music/etc., see `bot.md` for the design spec). Discord.js **v14**, **CommonJS**, Node >= 20 (Docker uses node:22-alpine), **MySQL** via `mysql2/promise`. All user-facing text is **German**.

Scope: moderation commands (ban/kick/warn/timeout/mute...), warn escalation, report system, Discord-native AutoMod integration, toxicity word filter, anti-raid + captcha verification, invite tracking, welcome/leave cards (canvas), server/message logging, voice speech-recognition commands (de-DE).

## Commands

```bash
npm start        # node --env-file=.env index.js
npm test         # tests/run.js → runs every tests/smoke/*.js as child process (needs MySQL)
docker compose up -d --build   # prod-style run (external network discord_bot_net, MYSQL_HOST=mysql)
```

Deploy: push to `main` → GitHub Actions (`.github/workflows/deploy.yml`) runs smoke tests against MySQL 8.4 service, then SSH-deploys (`git pull` + docker compose) to the server at `/app/oreo-bot`.

## Environment (.env — see .env.example)

Required: `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, `MYSQL_HOST/USER/PASSWORD/DATABASE` (missing → exit 1 at startup).
Optional: `MYSQL_PORT` (3306), `MODLOG_CHANNEL_ID` (global fallback mod-log — **applies to every guild**, cross-guild leak risk), `DEVELOPER_ID` (**owner-tier backdoor in every guild**, also bypasses /setup gate — security relevant).

## Startup flow (index.js)

env check → create Client (privileged intents: GuildMembers, MessageContent, GuildVoiceStates + automod/invites/moderation; partials: **Message only**) → `addSpeechEvent` (de-DE speech recognition, loaded unconditionally) → load commands/events → DB ping → `ensureSchema()` (replays `server/schema.sql` every boot, swallows errnos 1060/1061/1091/1146) → deploy slash commands **to the single GUILD_ID only** → login. Events, however, fire in *all* guilds — the bot is single-guild by config, multi-guild by behavior.

## Critical invariants — read before touching interaction code

1. **Auto-defer:** `index.js` defers **every** slash command **ephemerally** before `execute()`, unless the command opts out by exporting `showsModal` — either `true` or a `(interaction) => boolean` function (for per-subcommand cases). When `showsModal` (or its return value) is truthy, the auto-defer is skipped so the command can call `showModal()`. If the `showsModal` function throws, `index.js` catches it, logs the error, and falls back to deferring normally (safe default). New modal commands declare `showsModal` on their own module and never need to touch `index.js`.
2. **Monkey-patched reply:** `interaction.reply` is patched to become `editReply` once deferred/replied. Consequence: commands can never produce a *public* reply through `reply()` (defer is ephemeral); `flags` passed later are dropped.
3. **Component routing:** buttons/selects/modals chain through `dispatch()` of `src/interactions/{report,announcement,captcha,welcome}.js` (customId prefixes `report:`, `announcement:`, `captcha_`, `welcome:`/`leave:`); unhandled → "Unbekannte Interaktion". New component features: add a dispatcher to the chain in index.js.
4. **Autocomplete bypasses tier checks** (index.js dispatches autocomplete before `requireTier`). Anything exposed via autocomplete (ban list in /unban, wordlist in /automod) is readable by every member.
5. **Duration syntax** (`src/duration.js`): `s / m / h / t / w` — German `t` = Tag. **`d` is NOT accepted** even though several option descriptions advertise `7d`. Max timeout: 28d (`MAX_TIMEOUT_MS`).
6. **Permission tiers** (`src/perms.js`): `supporter < moderator < owner` from `role_permissions` table — tier assignments per bot.md: warn/timeout/untimeout = supporter; ban/unban/kick/softban and other mod tools = moderator; config/automod/setup = owner. Guild owner and `DEVELOPER_ID` are always `owner`. A "Ramen level" link can grant supporter via shared `guild_users.level`.
7. **Cases:** all punishments write to `infractions` with a per-guild atomic `case_number` (LAST_INSERT_ID trick in `src/cases.js`, transactional). Temp-bans/mutes rely on the case row's `expires_at` + `active=1` — if `createCase` fails after a ban succeeded, the temp-ban silently becomes permanent (known bug).
8. **Background loop** (`src/background.js`): one 60s `setInterval` — expires temp-bans/mutes (system unban/unmute case + modlog) and applies warn decay. **No re-entrancy guard**; not safe for two bot instances on one DB.
9. **In-memory state lost on restart:** captcha kick-timers & verify-channel cleanup (`guildMemberAdd`), report cooldowns, invite cache, channel-hopping history, anti-raid state. Nothing re-hydrates from DB.

## Layout

```
index.js                 entrypoint + interaction dispatch (see invariants)
src/commands/*.js        30 slash commands ({data, requiredTier?, execute, autocomplete?})
src/events/*.js          21 gateway event handlers ({name, once?, execute}) — auto-loaded
src/interactions/*.js    component dispatchers (report, announcement, captcha, welcome)
src/db.js                lazy mysql2 pool singleton (limit 10) — no timezone option set
src/schema.js            naive migration runner over server/schema.sql (splits on line-final ';')
src/config.js            per-guild config DAL over `guilds` row — ~70 getters/setters, NO caching
                         (every getter re-SELECTs the full ~40-column row)
src/perms.js             tier resolution + requireTier middleware
src/cases.js             infractions DAL (+ Ramen currency penalty inside case transaction)
src/escalations.js       escalation_rules DAL + applyEscalation (fires on EXACT warn-count match only)
src/reports.js           reports DAL + in-memory cooldown
src/automod.js           Discord-native AutoMod rules/wordlist/exemptions
src/invites.js           in-memory invite-uses cache for join attribution
src/welcomeCard.js       canvas welcome/leave cards (fetches FULL member list per event)
src/background.js        60s expiry/decay loop
src/composables/mutedRole.js  find/create Muted role (overwrites applied on creation only)
server/schema.sql        full schema + staged ALTERs (shared DB with "Ramen" bot:
                         guild_users.level, user_cards are external — schema drift trap)
tests/run.js + tests/smoke/*.js  14 smoke tests (mocked DB/Discord), run as child processes
assets/fonts             fonts for canvas cards
```

## Database

MySQL, shared with the Ramen bot (`guild_users`, `user_cards`). Oreo tables: `guilds` (config + case counter), `infractions`, `reports`, `escalation_rules`, `role_permissions`, `automod_rules/_wordlist/_exemptions`, `bad_words`, `market_listings` (unused). All queries parameterized. `reason` column is VARCHAR(512) but commands set no max length on reason options (overflow → case insert fails after punishment executed).

## Testing

`npm test` needs a reachable MySQL (reads `.env` itself). Smoke tests mock discord.js objects and cover: duration parsing, escalations, modlog embeds, reports DAL, captcha+toxicity, channel hopping, account-age, join roles, message/server logging, stats, audit mirror, voice rec. **Not covered:** component dispatch chain, anti-raid, invite tracking, welcome cards, partials behavior.

## Known bugs / audit findings (2026-07-06 full audit — fix these before building on top)

Top criticals (full list in the audit summary from that session):
- Captcha answer readable in button customId → bots auto-solve (`src/interactions/captcha.js`).
- Speech recognition streams ALL voice audio to Google's STT regardless of the `voice_rec_enabled` config (checked only after transcription) — privacy issue.
- `d` duration suffix advertised but rejected (ban/mute/config help texts).
- Missing `Partials.GuildMember`/`User` → leave/update events silently dropped for uncached members.
- Unbounded duration on /ban `999999w` → Invalid Date → temp-ban row never written → never unbanned.
- Anti-raid + per-user verify channels can self-DoS (channel per joiner, hard-coded 5 joins/10s, @here).
- Channel-hopping detector keyed by userId across guilds (false 24h timeouts) + memory leak.
- Event handler promises not caught in `loadEvents.js`; no `unhandledRejection` handler → DB blip during event = process crash.
- `guild_users.level` queried but not in schema.sql (works only on the shared Ramen DB).
- No config caching → 6–10 identical SELECTs per event.

## Conventions

- German for all user-facing strings, English for code/comments/logs (mixed today; keep German UX).
- Moderation commands: fetch target member with `.fetch().catch(() => null)` (not cache), check role hierarchy (target vs moderator AND vs bot), DM before punishing where the user can no longer be DMed after (ban/kick), then act, then `createCase`, then modlog embed.
- Commands export `{ data, requiredTier, execute }`; events export `{ name, once?, execute }` with their own try/catch.
- Commit style: `feat: ...` conventional-ish, imperative.
