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
Optional: `MYSQL_PORT` (3306), `MODLOG_CHANNEL_ID` (global fallback mod-log — **applies to every guild that hasn't set its own** via `/config channel set type:modlog`, cross-guild leak risk), `DEVELOPER_ID` (**owner-tier backdoor in every guild**, also bypasses /setup gate — security relevant).

## Startup flow (index.js)

env check → create Client (privileged intents: GuildMembers, MessageContent, GuildVoiceStates + automod/invites/moderation; partials: `Message`, `GuildMember`, `User`) → `addSpeechEvent` (de-DE speech recognition, loaded unconditionally) → load commands/events (`loadEvents.js` wraps every handler's `execute()` in `.catch()`, logging `[events] Handler <file> (<name>) failed:` instead of letting a rejection escape) → DB ping → `ensureSchema()` (replays `server/schema.sql` every boot, swallows errnos 1060/1061/1091/1146) → deploy slash commands **to the single GUILD_ID only** → login. Events, however, fire in *all* guilds — the bot is single-guild by config, multi-guild by behavior.

Process-level safety net: `process.on('unhandledRejection', ...)` logs and continues (does not exit); `process.on('uncaughtException', ...)` logs and calls `process.exit(1)`.

## Critical invariants — read before touching interaction code

1. **Auto-defer:** `index.js` defers **every** slash command **ephemerally** before `execute()`, unless the command opts out by exporting `showsModal` — either `true` or a `(interaction) => boolean` function (for per-subcommand cases). When `showsModal` (or its return value) is truthy, the auto-defer is skipped so the command can call `showModal()`. If the `showsModal` function throws, `index.js` catches it, logs the error, and falls back to deferring normally (safe default). New modal commands declare `showsModal` on their own module and never need to touch `index.js`.
2. **Monkey-patched reply:** `interaction.reply` is patched to become `editReply` once deferred/replied. Consequence: commands can never produce a *public* reply through `reply()` (defer is ephemeral); `flags` passed later are dropped.
3. **Component routing:** buttons/selects/modals chain through `dispatch()` of `src/interactions/{report,announcement,captcha,welcome}.js` (customId prefixes `report:`, `announcement:`, `captcha_`, `welcome:`/`leave:`); unhandled → "Unbekannte Interaktion". New component features: add a dispatcher to the chain in index.js.
4. **Autocomplete enforces command tier:** `index.js` checks `command.requiredTier` via `perms.hasTier(...)` before calling `command.autocomplete()`; a disallowed caller gets an empty `interaction.respond([])`, not real data (e.g. ban list in /unban, wordlist in /automod). Commands without a `requiredTier` (e.g. `/warnings`) have nothing to gate.
5. **Duration syntax** (`src/duration.js`): `s / m / h / t / d / w` — German `t` = Tag, and `d` is accepted as a plain alias of `t` (both map to 86 400 000 ms). Max **timeout**: 28d (`MAX_TIMEOUT_MS`, Discord API hard limit). Max **temp-ban/temp-mute**: 365d (`MAX_TEMP_MS`) — ban.js/mute.js enforce this cap.
6. **Permission tiers** (`src/perms.js`): `supporter < moderator < owner` from `role_permissions` table — tier assignments per bot.md: warn/timeout/untimeout = supporter; ban/unban/kick/softban and other mod tools = moderator; config/automod/setup = owner. Guild owner and `DEVELOPER_ID` are always `owner`. `TIER_PERMISSIONS` (also in `perms.js`) maps each tier to a Discord `default_member_permissions` value used by `loadCommands.js` for client-side command visibility only — real authorization is always `requireTier`/`hasTier` (DB-backed). `/warnings` is the one command with no `requiredTier` at all — see item 12. A "Ramen level" link can grant supporter via shared `guild_users.level` (see Database section — not present in this repo's schema).
7. **Cases** (`src/cases.js`): all punishments write to `infractions` with a per-guild atomic `case_number` (LAST_INSERT_ID trick, transactional). Temp punishments pass `expiresInMs` (ms from now); `createCase` computes `expires_at` **DB-side** via `DATE_ADD(NOW(), INTERVAL ? SECOND)` so no JS `Date` ever crosses the wire (avoids Node-local-vs-MySQL-server timezone skew). **New code must use `expiresInMs`, never pass a JS `Date`** — the legacy `expiresAt: Date` param still exists only for callers not yet migrated. `reason` is defensively truncated to 512 chars inside `createCase` regardless of caller (column is `VARCHAR(512)`); slash-command reason options also carry `.setMaxLength(512)`. If `createCase` fails **after** the Discord-side action already succeeded, ban.js/mute.js/timeout.js revert it (unban/role-remove/timeout-clear) rather than leaving an untracked, silently-permanent punishment. ban.js/mute.js also call `cases.deactivateActiveInfractions(guildId, targetId, type)` before creating a fresh temp punishment, so a stale active row can't later cause `background.js` to auto-expire the wrong case.
8. **Background loop** (`src/background.js`): one 60s `setInterval`, guarded by a process-local `running` flag so overlapping ticks are skipped (still **not** safe across two bot instances on one DB — no distributed lock). Each tick: expires temp-bans/mutes (system unban/unmute case + modlog), deactivates expired `type='timeout'` rows via a bulk `UPDATE` (no Discord call — Discord lifts timeouts itself, no system case needed), then applies warn decay.
9. **Config caching** (`src/config.js`): the per-guild config row and the normalized bad-words list are cached in-process for 30s (`ROW_CACHE_TTL_MS`). Every setter in `config.js` calls `invalidateGuildRowCache`/the bad-words equivalent right after its `UPDATE`. **Any code that runs a raw `UPDATE guilds SET ...` outside `config.js`'s own setters (e.g. the direct-column updates in `src/commands/config.js`) must call the exported `invalidateGuildRowCache(guildId)` itself**, or reads can serve stale data for up to 30s — already done for all such sites in `src/commands/config.js`, but keep it in mind for new ones. Toxicity/bad-word matching should go through `getNormalizedBadWords(guildId)` (pre-normalized, cached) rather than re-normalizing every bad word per message.
10. **Shared moderation helpers — new code must use these, not hand-roll the pattern:** `sendModLog(interaction, embedParams)` (`src/modlog.js`) for the fetch-channel → build-embed → send → ephemeral-warning-on-failure tail; `validateModTarget(interaction, target, { action, requireMember })` (`src/modGuards.js`) for the self/bot/owner/hierarchy/bot-ability guard sequence (per-action German texts preserved in an `ACTION_RULES` registry; `/untimeout` is deliberately **not** converged — its custom "not currently timed out" check doesn't fit the shared guard order); `resolveAuditExecutor(guild, auditLogEventType, targetId, opts)` (`src/auditExecutor.js`) for the `*-log` event handlers' "who did this" audit-log lookup. `cleanup`/`lockdown`/`slowmode`/`unlock` still post their modlog entries inline (not via `sendModLog`), with a silent-skip-on-unset shape rather than the ephemeral-warning shape the rest of the mod commands now have.
11. **In-memory state lost on restart:** captcha kick-timers & verify-channel cleanup (`guildMemberAdd`), report cooldowns, invite cache, anti-raid state, channel-hopping history. Nothing re-hydrates from DB. Channel-hopping history is keyed `` `${guildId}:${userId}` `` (not bare `userId` — avoids cross-guild false triggers), stores only `{ timestamp, channelId, messageId }` per entry (not the full Discord `Message` object), and is swept every 60s to drop empty/stale keys, bounding memory growth.
12. **Moderation UX mechanics:** ban.js/kick.js send a best-effort DM to the target (`.catch(() => null)`) **before** executing the punishment, since a banned/kicked user can no longer be DMed after (mute.js does not — the user stays in the server and remains DMable). `/warnings` needs no tier: it defaults to the caller's own warnings and only runs an in-command `perms.hasTier(..., 'supporter')` check when looking up *someone else's*. `src/interactions/report.js`'s modal-resolve flow runs the same `escalations.applyEscalation` warn.js uses when the chosen action is `warn`. If a report's channel post fails after its DB row was already inserted, `src/commands/report.js` deletes that row (`reports.deleteReport`) and tells the reporter explicitly their report was **not** saved, rather than leaving a silent orphan. A member who rejoins while an active `mute` infraction exists has the Muted role re-applied automatically (`guildMemberAdd.js`); the mod-log entry only claims success if `roles.add` actually succeeded, otherwise it posts an explicit "could not re-apply" warning instead of a phantom success line.

## Layout

```
index.js                 entrypoint + interaction dispatch (see invariants)
src/commands/*.js        30 slash commands ({data, requiredTier?, execute, autocomplete?})
src/events/*.js          21 gateway event handlers ({name, once?, execute}) — auto-loaded, promise-wrapped
src/interactions/*.js    component dispatchers (report, announcement, captcha, welcome)
src/db.js                lazy mysql2 pool singleton (limit 10) — no timezone option set
src/schema.js            naive migration runner over server/schema.sql (splits on line-final ';')
src/config.js            per-guild config DAL over `guilds` row — ~70 getters/setters, 30s row +
                         bad-words cache (see invariant 9); every setter invalidates on write
src/perms.js             tier resolution + requireTier middleware + TIER_PERMISSIONS registry
src/cases.js             infractions DAL (expiresInMs DB-side expiry, hasActiveInfraction,
                         deactivateActiveInfractions) + Ramen currency penalty in case transaction
src/modGuards.js         validateModTarget — shared self/bot/owner/hierarchy/ability guard (invariant 10)
src/auditExecutor.js     resolveAuditExecutor — shared audit-log "who did this" lookup (invariant 10)
src/escalations.js       escalation_rules DAL + applyEscalation (fires on EXACT warn-count match only)
src/reports.js           reports DAL + in-memory cooldown + deleteReport (post-failure compensation)
src/automod.js           Discord-native AutoMod rules/wordlist/exemptions
src/invites.js           in-memory invite-uses cache for join attribution
src/welcomeCard.js       canvas welcome/leave cards (optional memberCount param avoids double-fetch)
src/background.js        60s expiry/decay loop — re-entrancy guard + timeout-row expiry sweep
src/composables/mutedRole.js  getOrCreateMutedRole (creates) + getMutedRole (read-only resolution)
server/schema.sql        full schema + staged ALTERs (shared DB with "Ramen" bot:
                         guild_users.level, user_cards are external — schema drift trap)
tests/run.js + tests/smoke/*.js  14 smoke tests (mocked DB/Discord), run as child processes
assets/fonts             fonts for canvas cards
```

## Database

MySQL, shared with the Ramen bot (`guild_users`, `user_cards`). Oreo tables: `guilds` (config + case counter), `infractions`, `reports`, `escalation_rules`, `role_permissions`, `automod_rules/_wordlist/_exemptions`, `bad_words`, `market_listings` (unused). All queries parameterized. `infractions.reason` is `VARCHAR(512)` — see invariant 7 for the defensive truncation and `.setMaxLength(512)` coverage. `guild_users.level` is queried by `src/perms.js` (Ramen-level → supporter grant) but is **not** defined in `server/schema.sql` — it only works against the shared Ramen DB; a fresh/standalone DB will fail that lookup (tracked as an open old-plan item, not fixed in this repo).

## Testing

`npm test` needs a reachable MySQL (reads `.env` itself). Smoke tests mock discord.js objects and cover: duration parsing, escalations, modlog embeds, reports DAL, captcha+toxicity, channel hopping, account-age, join roles, message/server logging, stats, audit mirror, voice rec. **Not covered:** component dispatch chain, anti-raid, invite tracking, welcome cards, partials behavior.

## Known issues / deferred work (as of 2026-07-07)

- Captcha answer is readable in the button `customId` → a bot/script can auto-solve without ever seeing the image (`src/interactions/captcha.js`).
- Anti-raid creates a **dedicated verify channel per joiner** — hard-coded 5 joins/10s can self-DoS a raid wave (channel-create spam) and pings `@here`.
- Voice-command matching in `src/events/speech.js` is plain substring matching (`cleanText.includes('ban')` etc.) — prone to false positives from ordinary conversation; the handler also streams all voice audio to Google STT regardless of `voice_rec_enabled` (checked only after transcription) — privacy issue.
- `guild_users.level` is queried (`src/perms.js`) but not defined in `server/schema.sql` — only works on the shared Ramen DB (see Database section).
- Escalation concurrent-warn race **[PLAUSIBLE, unfixed]**: two near-simultaneous warn actions on the same user (e.g. two `/warn`s, or a `/warn` racing a report-warn) can both read the same active-warning count and both fire (or both miss) the same escalation rule — `applyEscalation` has no transactional guard around count-then-act.
- `MODLOG_CHANNEL_ID` env fallback still applies globally to every guild that hasn't configured its own mod-log channel — cross-guild leak risk (see Environment section).
- `/lockdown` and `/unlock` don't extend to thread channels under the locked channel (threads keep their own send permissions).
- Obfuscation-aware toxicity matching (`src/obfuscation.js` character-substitution normalization) can produce false-positive matches on legitimate words.
- `cleanup`/`lockdown`/`slowmode`/`unlock` post modlog entries inline rather than via `sendModLog` — candidate for later convergence (see invariant 10).
- Minor: the config/bad-words 30s TTL cache has no request-coalescing — concurrent reads during the same cold window can each issue a duplicate SELECT (cosmetic, self-heals immediately).
- Minor: `timeout.js` (via `validateModTarget`'s fixed guard order) fetches the target member before the self/bot/owner checks, one extra cached fetch versus a fail-fast order; no user-visible difference.
- Deliberate, not a bug: `/untimeout` was not converged onto `validateModTarget` (see invariant 10).

Old-plan Tasks 10–15 (captcha server-side answers, persistent verifications, shared verify channel, speech privacy/hardening, `guild_users.level`) continue in `.superpowers/sdd/2026-07-06-audit-bugfixes.md` separately.

## Conventions

- German for all user-facing strings, English for code/comments/logs (mixed today; keep German UX).
- Moderation commands: fetch target member with `.fetch().catch(() => null)` (not cache), check role hierarchy (target vs moderator AND vs bot), DM before punishing where the user can no longer be DMed after (ban/kick), then act, then `createCase`, then modlog embed. For ban/kick/softban/mute/warn/timeout/unmute this whole guard sequence is centralized in `validateModTarget` (invariant 10) — don't reimplement it inline in new commands.
- Commands export `{ data, requiredTier, execute }`; `requiredTier` is optional — its absence (e.g. `/warnings`) means the command is open to every guild member, and any tier gating for specific paths must be done manually inside `execute`. Events export `{ name, once?, execute }` with their own try/catch.
- Commit style: conventional-ish prefixes (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`), imperative mood.
