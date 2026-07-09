# Oreo Code-Review Fixes 2026-07-07

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Fix all CONFIRMED findings from the 2026-07-07 full-codebase review: re-ban data corruption, never-expiring timeout rows, timezone-skewed expiry, background re-entrancy, cross-guild channel-hop false positives, phantom-punishment cases, dropped automod logs, kick audit-reason loss, reason-edit overflow, orphaned reports, escalation skips, eternal spinners, spec-violating /warnings tier, missing ban/kick DMs, mute-evasion on rejoin, config SELECT storm — plus the duplication refactors (sendModLog, validateModTarget, auditExecutor) and a CLAUDE.md refresh.

**Architecture:** Targeted fixes in existing structure. New modules: `src/modGuards.js`, `src/auditExecutor.js`. No new dependencies, no schema changes except none required (idx_active_type_expires already exists).

## Global Constraints

- All user-facing strings in **German**; code/comments/logs in English (match existing file style).
- CommonJS only, no new npm dependencies, discord.js v14.
- Every slash command is auto-deferred ephemerally by index.js and `interaction.reply` is monkey-patched to `editReply` — this mechanism STAYS in this round; do not remove it.
- Error messages to moderators must be clear and actionable ("was ging schief, was tun") — never a bare generic where the cause is knowable.
- `npm test` needs reachable MySQL (may be unavailable — then run the non-DB smoke tests individually: `node tests/smoke/duration.js`, `node tests/smoke/channel_hopping.js`, etc., and note which suites were skipped).
- Commit after every task with `fix:`/`feat:`/`refactor:`/`docs:` conventional message.
- Working dir: `c:\Users\Lukas\Documents\Home Discord Bots\Oreo`, branch `fix/audit-2026-07`.
- Tier ladder `supporter < moderator < owner`. Reason column is `VARCHAR(512)`.

---

### Task 1: Timezone-safe expiry (DB-side expires_at via expiresInMs)

**Files:** `src/cases.js`, `src/commands/ban.js`, `src/commands/timeout.js`, `src/commands/mute.js`, `src/events/messageCreate.js` (2 call sites), `src/escalations.js` (~line 334), `src/interactions/report.js` (~line 354). Tests: check `tests/smoke/escalations.js`, `tests/smoke/modlog.js`.

Extend `createCase` with an `expiresInMs = null` param. When set, compute `expires_at` in SQL:

```js
const expiresSql = expiresInMs != null ? 'DATE_ADD(NOW(), INTERVAL ? SECOND)' : '?';
const expiresParam = expiresInMs != null ? Math.round(Number(expiresInMs) / 1000) : expiresAt;
```

and interpolate `${expiresSql}` into the INSERT's VALUES for the expires_at position. Migrate ALL callers that pass `expiresAt:` to pass `expiresInMs: durationMs` instead; delete local `new Date(Date.now() + durationMs)` values; change revert-conditions `if (expiresAt)` in ban.js/mute.js to `if (durationMs)`. Verify with `grep -rn "expiresAt:" src/` → no createCase call passes it. Legacy `expiresAt` param stays supported in cases.js.

- [ ] Implement, run `node tests/smoke/duration.js` + `npm test` (or note DB-skip), commit `fix: compute expires_at in SQL to remove timezone skew on temp punishments`

---

### Task 2: Background loop — re-entrancy guard + expire timeout rows

**Files:** `src/background.js`

1. Wrap the 60s `setInterval` body in a `let running = false;` guard: `if (running) return; running = true; try { await runDecayAndExpiry(client); } catch (err) { console.error(...); } finally { running = false; }`.
2. Add a step to `runDecayAndExpiry`: deactivate expired timeout rows with a single SQL (no Discord I/O — Discord lifts timeouts itself):
   `UPDATE infractions SET active = 0 WHERE type = 'timeout' AND active = 1 AND expires_at IS NOT NULL AND expires_at < NOW()` — log the affected-row count when > 0 (`console.log('[background] Deactivated N expired timeout case(s)')`).

- [ ] Implement, test, commit `fix: guard background loop against overlap and expire timeout infractions`

---

### Task 3: Ban/kick correctness — stale-row dedup, DM before punish, kick reason signature

**Files:** `src/commands/ban.js`, `src/commands/kick.js`, `src/commands/mute.js`

1. **ban.js:** after the ban succeeds and BEFORE `createCase`, call `await cases.deactivateActiveInfractions(interaction.guildId, target.id, 'ban').catch(err => console.error('[ban] Deactivating old ban rows failed:', err));` (same helper unban.js:61 uses). This prevents a stale temp-ban row from later auto-unbanning a permanent re-ban (background.js unbans on ANY active expired ban row).
2. **mute.js:** same class of bug — before `createCase`, deactivate old active `'mute'` rows.
3. **timeout.js is NOT in this task** (Task 5 owns it).
4. **kick.js:52:** `guild.members.kick(target.id, { reason: ... })` → second arg must be the STRING itself: `guild.members.kick(target.id, `${moderator.user.tag}: ${reason}`)` — discord.js v14 `kick(user, reason)`; the object silently drops the audit-log header.
5. **DM before punish (CLAUDE.md convention):** in ban.js and kick.js, immediately BEFORE `members.ban(...)` / `members.kick(...)`, attempt a DM to the target following the warn.js DM-embed pattern (guild name, action, reason, duration for temp bans). `catch(() => null)` — closed DMs must not block the punishment. Do NOT DM if the target is not a guild member (banning an ID not on the server: skip DM attempt when `targetMember` is null).

- [ ] Implement, test, commit `fix: dedup active ban/mute rows, DM targets before ban/kick, fix kick audit-log reason`

---

### Task 4: messageCreate — channel-hop scoping/pruning, no phantom punishments, automod modlog

**Files:** `src/events/messageCreate.js`. Test: `tests/smoke/channel_hopping.js` (update keys if needed).

1. **Channel-hop map:** key by `` `${guildId}:${userId}` `` (fixes cross-guild false 24h timeouts). Store minimal entries `{ timestamp, channelId, messageId }` instead of full Message objects. When pruning leaves an empty history, `delete` the key. Add a 60s `setInterval(...).unref?.()` sweep that deletes entries older than the window (map must not grow unboundedly). For the deletion of the spam messages, resolve via `client.channels.fetch(channelId)` + `channel.messages.delete(messageId).catch(() => null)` using the stored ids.
2. **No phantom punishment (channel-hop):** if `member.timeout(...)` THROWS, do NOT delete messages, do NOT createCase, do NOT post the success modlog. Instead `console.error` AND post a clear mod-log warning if a modlog channel is configured: `⚠️ Auto-Timeout gegen <@id> (Channel-Hopping) fehlgeschlagen — vermutlich fehlende Berechtigung (Rolle des Users über dem Bot?). Fehler: <err.message>`.
3. **No phantom punishment (toxicity-mute):** same rule — if `getOrCreateMutedRole` returns null or `roles.add` throws, skip createCase + success modlog; post the equivalent clear warning to the modlog channel instead.
4. **Automod 'delete' modlog:** replace `buildModLogEmbed({ action: 'automod_hit', ... })` (returns null → silently dropped) with the existing `buildAutoModHitEmbed(...)` from `src/modlog.js` — check its signature and pass the matched word/message context it expects.

- [ ] Implement, run `node tests/smoke/channel_hopping.js` + suite, commit `fix: guild-scope hop detection, drop phantom punishment records, log automod hits`

---

### Task 5: Command guard fixes — timeout, unmute, reason, warnings

**Files:** `src/commands/timeout.js`, `src/commands/unmute.js`, `src/commands/reason.js`, `src/cases.js`, `src/commands/warnings.js`

1. **timeout.js:** align to sibling conventions — resolve target via `await interaction.guild.members.fetch(target.id).catch(() => null)` (line ~63, replaces `cache.get`); self-check against `moderator.id` (not `interaction.user.id`); hierarchy via `moderator.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0` (like ban.js:73); keep the existing moderatable/owner checks.
2. **unmute.js:** add the same guard set untimeout.js:32-37 has: self-action, guild-owner target, hierarchy `comparePositionTo <= 0` denial ("Du kannst dieses Mitglied nicht entmuten (Rollen-Hierarchie).").
3. **reason.js:** add `.setMaxLength(512)` to the `new_reason` option.
4. **cases.js `editReason`:** the meta-case diff string `Alt: X → Neu: Y` can reach ~1037 chars > VARCHAR(512). Truncate the diff to 512 before INSERT (e.g. `diffReason.length > 512 ? diffReason.slice(0, 509) + '…' : diffReason`). Also defensively truncate `reason` to 512 in `createCase` (`reason = reason != null ? String(reason).slice(0, 512) : null`).
5. **warnings.js:** bot.md grants plain users "eigene Warns sehen". Remove `requiredTier: 'supporter'` from the export; inside `execute`, resolve the target user (option or self); if the target is NOT the invoker, require supporter: `const allowed = await perms.hasTier(interaction.guildId, interaction.member, 'supporter').catch(() => false); if (!allowed) return interaction.reply({ content: '❌ Du kannst nur deine eigenen Verwarnungen einsehen.', flags: MessageFlags.Ephemeral });`. Import perms. Check `src/loadCommands.js` — with no requiredTier the command gets no default-permission gate (visible to all), which is the spec'd behavior.

- [ ] Implement, test, commit `fix: align timeout/unmute guards, cap reason edits at column size, allow self-service /warnings`

---

### Task 6: Report flow + interaction error handling

**Files:** `src/commands/report.js`, `src/interactions/report.js`, `index.js`

1. **report.js orphan fix:** currently inserts the report row (~line 114) before fetching/sending to the report channel; failures leave an open row that `hasOpenReportFromTo` uses to block every retry. Fix by compensation: on channel-missing or send-failure, delete the just-created row (add a `deleteReport(id)`/`closeReport` helper to `src/reports.js` if none exists), then reply: `❌ Der Report-Channel ist nicht (mehr) verfügbar — dein Report wurde NICHT gespeichert. Bitte informiere das Server-Team direkt.` (If the embed doesn't need the row id, inserting after the successful send is equally acceptable — pick whichever the code supports with less churn and state why in the report.)
2. **interactions/report.js escalation hook:** in the resolve path where action `'warn'` calls `cases.createCase` (~line 346), afterwards run the same escalation sequence warn.js:122 uses: `const count = await cases.countActiveWarnings(guildId, targetId); await escalations.applyEscalation(...)` with matching params (read warn.js for the exact call shape, including modlog notification of the escalation).
3. **index.js component catch (~line 183):** replace the reply-only-if-fresh branch with full three-way handling so a deferred dispatcher failure doesn't strand the user on the spinner. Extract ONE helper used by all three catch blocks (tier-check ~139, execute ~159, component ~183): `async function sendInteractionError(interaction, content)` → `deferred ? editReply : replied ? followUp : reply`, each `.catch(() => null)`, content default `'❌ Beim Ausführen ist ein Fehler aufgetreten. Versuch es später erneut.'`.
4. **index.js defer exemptions (~line 127):** replace the hard-coded `commandName !== 'announcement'` + config-edit probe with a declarative flag: commands export `showsModal: true` (statically, or a function `(interaction) => boolean` for per-subcommand cases like config edit); index.js checks `const skipDefer = typeof command.showsModal === 'function' ? command.showsModal(interaction) : command.showsModal === true;`. Add the flag to `src/commands/announcement.js` (true) and `src/commands/config.js` (function checking `getSubcommand(false) === 'edit'`). New modal commands then never touch index.js.

- [ ] Implement, test, commit `fix: compensate failed report posts, escalate report warns, unify interaction error replies, declarative modal exemptions`

---

### Task 7: Config caching + hot-path efficiency + mute rejoin enforcement

**Files:** `src/config.js`, `index.js` (~line 69), `src/events/guildMemberAdd.js`, `src/welcomeCard.js`, `src/cases.js`

1. **config.js row cache:** module-level `Map` guildId → `{ row, fetchedAt }`, TTL 30s, used by `readGuildRow`; EVERY setter invalidates (`cache.delete(guildId)`) after its UPDATE. Fixes the 15-identical-SELECTs-per-join / 3-per-message storm without touching call sites.
2. **config.js bad-words cache:** cache `getBadWords` per guild (same TTL pattern or invalidate-on-write via `addBadWord`/`removeBadWord`). Additionally export `getNormalizedBadWords(guildId)` returning `[{ word, normalized }]` computed once per cache fill (require `./obfuscation` or wherever `normalize` lives — check messageCreate.js:134 for the exact import) and switch messageCreate.js to it so per-message re-normalization stops.
3. **index.js invite caching:** replace the sequential `for ... await cacheGuildInvites(guild)` loop with `await Promise.allSettled([...c.guilds.cache.values()].map((g) => invitesTracker.cacheGuildInvites(g)))`.
4. **Mute rejoin:** add `hasActiveInfraction(guildId, userId, type)` to `src/cases.js` (SELECT 1 ... WHERE active=1 AND type=? AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1). In guildMemberAdd, after join-roles/captcha logic, if an active `'mute'` row exists, re-apply the muted role (resolve via the existing `src/composables/mutedRole.js` — read it; use the get-only path, don't create a role on join) with reason `'Oreo: Aktiver Mute — Rolle nach Rejoin wieder angewendet'`, and log to modlog channel if configured: `🔇 <@id> ist mit aktivem Mute erneut beigetreten — Muted-Rolle wieder angewendet.`
5. **welcomeCard.js:** `generateCard` and `formatWelcomeMessage` each run `guild.members.fetch()` (full list). Refactor both to accept an optional `memberCount` param; compute the count ONCE in guildMemberAdd (single `guild.members.fetch()` with the existing `guild.memberCount` fallback) and pass it to both calls.

- [ ] Implement, test, commit `perf: cache guild config and bad words, parallel invite warmup, re-apply mute on rejoin, single member fetch for welcome`

---

### Task 8: Shared moderation helpers — sendModLog + validateModTarget + tier registry

**Files:** `src/modlog.js`, new `src/modGuards.js`, `src/perms.js`, `src/loadCommands.js`, `src/commands/setup.js`, and the commands: ban, kick, mute, softban, warn, timeout, unban, unmute, untimeout, removewarn, reason

1. **`sendModLog(interaction, embedParams)` in src/modlog.js:** encapsulates getModLogChannelId → if unset: ephemeral followUp `'⚠️ Mod-Log-Channel ist nicht konfiguriert (/setup) — die Aktion wurde NICHT geloggt.'` → channels.fetch → buildModLogEmbed(embedParams) → send → catch: followUp `'⚠️ Mod-Log-Eintrag fehlgeschlagen — prüfe die Channel-Berechtigungen.'` (all followUps ephemeral, `.catch(() => null)`). Replace the duplicated tail in ALL commands that build modlog embeds (~9-11 — grep `buildModLogEmbed` in src/commands/). mute.js/unmute.js currently silently skip the warnings — after this task they behave like the rest (that is the point).
2. **`validateModTarget` in new src/modGuards.js:** `async validateModTarget(interaction, target, { action, requireMember = true })` → fetches member via `.fetch().catch(() => null)`, runs the standard guards (self, bot itself, guild owner, moderator hierarchy via comparePositionTo, bot-vs-target hierarchy / action-ability: `bannable`/`kickable`/`moderatable` depending on `action`), returns `{ ok: true, targetMember }` or `{ ok: false, message }` with the existing German denial texts. Replace the copy-pasted guard blocks in ban/kick/mute/softban/warn/timeout (timeout.js was aligned in Task 5 — converge it onto the helper now). Preserve each command's action-specific checks (e.g. ban works on non-members: `requireMember: false`).
3. **Tier registry:** `src/perms.js` exports the tier→Discord-default-permission mapping (move `TIER_PERMISSIONS` content from loadCommands.js next to `TIERS`); loadCommands.js imports it. Replace the `command.data.name === 'setup'` special case: setup.js exports `defaultMemberPermissions: PermissionFlagsBits.Administrator` and loadCommands reads `command.defaultMemberPermissions` generically before falling back to the tier map.
4. Pure refactor: user-visible behavior identical EXCEPT mute/unmute gaining the modlog warnings (intended).

- [ ] Implement, run full test suite, commit `refactor: shared sendModLog, validateModTarget and tier registry replace 6-11x duplication`

---

### Task 9: Audit-executor helper

**Files:** new `src/auditExecutor.js`; events: channelCreate, channelDelete, channelUpdate, guildMemberUpdate (2 sites), guildUpdate, roleCreate, roleDelete, roleUpdate, voiceStateUpdate

`resolveAuditExecutor(guild, auditLogEventType, targetId, { windowMs = 10_000, limit = 5 } = {})` → fetches audit logs, finds the newest entry matching targetId within the window, returns `{ executorTag: '<@id> (tag)', executor }` or `null`. Replace all 11 duplicated lookups; keep each handler's existing fallback text when null.

- [ ] Implement, test, commit `refactor: single audit-log executor resolver replaces 11 copies`

---

### Task 10: CLAUDE.md refresh + stale-entry purge

**Files:** `CLAUDE.md` (+ read `bot.md` for the tier table cross-check)

Per CLAUDE.md's own maintenance rule, fix ALL stale statements found by the review:
- Invariant 5: `d` IS accepted (alias of `t`) since commit 06e3dc5 — rewrite; remove the "advertised but rejected" known-bug line.
- Startup flow: partials are `Message, GuildMember, User` (not "Message only"); remove the missing-partials known bug.
- Remove known bugs: "no unhandledRejection handler / event promises uncaught" (fixed 8f09f6b), "createCase fails → temp-ban silently permanent" (fixed 0dfb0e1 + Task 1/2), "/ban 999999w unbounded" (fixed 06e3dc5).
- Document the new mechanisms from this plan: `expiresInMs` (DB-side expiry — never pass JS Dates in new code), background timeout-row expiry + re-entrancy guard, `sendModLog`/`validateModTarget`/`resolveAuditExecutor` helpers (new code MUST use them), config row cache (30s TTL, setters invalidate), `showsModal` declarative defer exemption, channel-hop keys `guildId:userId`, DM-before-ban/kick now implemented, /warnings self-service for plain users, report-warn escalations, mute re-applied on rejoin.
- Update the Known-bugs/Deferred list: drop everything this plan fixed; keep genuinely open items (captcha answer leak in customIds until old-plan Task 10, per-joiner verify channels until old-plan Task 12, speech substring matching until old-plan Task 14, MODLOG env fallback, lockdown thread coverage, escalation race on concurrent warns [PLAUSIBLE, unfixed], obfuscation false positives).

- [ ] Update, run full suite one final time, commit `docs: refresh CLAUDE.md after 2026-07-07 review round`

---

## Explicitly OUT of this round

- Removing the interaction.reply monkey-patch (works, documented; removal is high-risk churn).
- config.js getter/setter collapse to generic get/set (cache fixes the cost; API churn deferred).
- Old-plan Tasks 10–15 (captcha server-side answers, persistent verifications, shared verify channel, speech privacy/hardening, guild_users.level) — continue `2026-07-06-audit-bugfixes.md` separately.
- Escalation concurrent-warn race (needs transactional redesign; documented in CLAUDE.md).
