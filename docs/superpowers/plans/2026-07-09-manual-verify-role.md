# Manuelle Verified-Rolle = verifiziert — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wenn einem Nicht-Bot-Mitglied manuell eine Verified-Rolle zugewiesen wird, behandelt Oreo es als verifiziert — löscht die `pending_verifications`-Deadline (kein Kick) und entfernt die Unverified-Rolle(n).

**Architecture:** Neuer Gateway-Event-Handler `src/events/guildMemberUpdate.js` (auto-geladen von `loadEvents.js`, kein `index.js`-Eingriff). Die Entscheidungslogik lebt in einer reinen Funktion `_internal.decideVerification(...)`, die ohne DB/Discord unit-testbar ist; `execute` verdrahtet nur `config`/`verifications`/Discord.

**Tech Stack:** discord.js v14, CommonJS, Node >= 20. Tests: `node:assert`, Smoke-Test als eigenständiges Skript (Oreo-Muster).

## Global Constraints

- **Sprache:** user-facing Strings **Deutsch**, Code/Kommentare/Logs Englisch.
- **discord.js v14**, CommonJS. Event-Handler exportieren `{ name, once?, execute }`.
- Intent `GatewayIntentBits.GuildMembers` ist bereits aktiv (nötig für `GuildMemberUpdate`).
- `verifications.markVerified(guildId, userId)` löscht die `pending_verifications`-Zeile (DELETE, idempotent) — **derselbe** Aufruf wie im Captcha-Erfolgspfad.
- `config.getVerifiedRoleIds(guildId)` / `config.getUnverifiedRoleIds(guildId)` liefern `string[]`.
- **Bots:** keine Auto-Rolle, kein Tracking — `execute` bricht bei `newMember.user.bot` ab.
- **Kein Modlog** beim manuellen Verify.
- Commit-Stil: konventionelle Prefixe (`feat:`, `docs:`), imperativ.
- Reine Logik in `module.exports._internal` exponieren (Oreo-Muster wie `captcha._internal`).

## File Structure

```
src/events/guildMemberUpdate.js   NEU — Handler {name, execute, _internal:{decideVerification}}
tests/smoke/manual_verify.js      NEU — no-DB Smoke-Test der reinen decideVerification
CLAUDE.md                         Aktualisierung (Invariante + Layout + Testing) — Maintenance-Rule
```

---

### Task 1: `guildMemberUpdate`-Handler + reine `decideVerification`

**Files:**
- Create: `src/events/guildMemberUpdate.js`
- Test: `tests/smoke/manual_verify.js`

**Interfaces:**
- Consumes: `config.getVerifiedRoleIds(guildId) -> Promise<string[]>`, `config.getUnverifiedRoleIds(guildId) -> Promise<string[]>`, `verifications.markVerified(guildId, userId) -> Promise<void>` (DELETE, idempotent).
- Produces:
  - `module.exports = { name: Events.GuildMemberUpdate, execute, _internal: { decideVerification } }`.
  - `decideVerification({ isBot, oldRoleIds, newRoleIds, verifiedRoleIds, unverifiedRoleIds, oldPartial }) -> { verify: boolean, removeUnverified: string[] }` — pure, no async, no I/O.

- [ ] **Step 1: Write the failing test — `tests/smoke/manual_verify.js`**

```js
const assert = require('node:assert');
const handler = require('../../src/events/guildMemberUpdate');
const { decideVerification } = handler._internal;

// verified role newly added -> verify + remove the unverified role the member has
{
  const r = decideVerification({
    isBot: false, oldRoleIds: ['U'], newRoleIds: ['U', 'V'],
    verifiedRoleIds: ['V'], unverifiedRoleIds: ['U'], oldPartial: false,
  });
  assert.strictEqual(r.verify, true, 'verified newly added -> verify');
  assert.deepStrictEqual(r.removeUnverified, ['U'], 'removes unverified role member has');
}

// no verified role in new set -> no action
{
  const r = decideVerification({
    isBot: false, oldRoleIds: ['U'], newRoleIds: ['U'],
    verifiedRoleIds: ['V'], unverifiedRoleIds: ['U'], oldPartial: false,
  });
  assert.strictEqual(r.verify, false, 'no verified role -> no action');
  assert.deepStrictEqual(r.removeUnverified, [], 'no roles to remove');
}

// bot -> no action even with a verified role present
{
  const r = decideVerification({
    isBot: true, oldRoleIds: [], newRoleIds: ['V'],
    verifiedRoleIds: ['V'], unverifiedRoleIds: [], oldPartial: false,
  });
  assert.strictEqual(r.verify, false, 'bot -> no action');
}

// already had a verified role before -> no action (nothing new)
{
  const r = decideVerification({
    isBot: false, oldRoleIds: ['V'], newRoleIds: ['V', 'X'],
    verifiedRoleIds: ['V'], unverifiedRoleIds: [], oldPartial: false,
  });
  assert.strictEqual(r.verify, false, 'already verified -> no action');
}

// oldMember partial (uncached) + verified now present -> reconcile (idempotent)
{
  const r = decideVerification({
    isBot: false, oldRoleIds: [], newRoleIds: ['V', 'U'],
    verifiedRoleIds: ['V'], unverifiedRoleIds: ['U'], oldPartial: true,
  });
  assert.strictEqual(r.verify, true, 'partial old -> reconcile');
  assert.deepStrictEqual(r.removeUnverified, ['U'], 'partial old removes unverified');
}

// removeUnverified only contains unverified roles the member actually has
{
  const r = decideVerification({
    isBot: false, oldRoleIds: [], newRoleIds: ['V'],
    verifiedRoleIds: ['V'], unverifiedRoleIds: ['U1', 'U2'], oldPartial: false,
  });
  assert.strictEqual(r.verify, true, 'verify true');
  assert.deepStrictEqual(r.removeUnverified, [], 'no unverified roles present -> none removed');
}

console.log('manual_verify smoke OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/smoke/manual_verify.js`
Expected: FAIL — `Cannot find module '../../src/events/guildMemberUpdate'`.

- [ ] **Step 3: Implement `src/events/guildMemberUpdate.js`**

```js
const { Events } = require('discord.js');
const config = require('../config');
const verifications = require('../verifications');

/**
 * Pure decision core — no DB/Discord I/O, unit-testable.
 * Returns whether the member should now be treated as verified and which
 * unverified role ids to strip (only those the member currently has).
 */
function decideVerification({ isBot, oldRoleIds, newRoleIds, verifiedRoleIds, unverifiedRoleIds, oldPartial }) {
  if (isBot) return { verify: false, removeUnverified: [] };

  const verifiedSet = new Set(verifiedRoleIds);
  const hasVerifiedNow = newRoleIds.some((id) => verifiedSet.has(id));
  if (!hasVerifiedNow) return { verify: false, removeUnverified: [] };

  // If the old (cached) state already had a verified role, nothing new happened.
  // When oldMember is partial we can't diff, so we reconcile (idempotent).
  const hadVerifiedBefore = !oldPartial && oldRoleIds.some((id) => verifiedSet.has(id));
  if (hadVerifiedBefore) return { verify: false, removeUnverified: [] };

  const newSet = new Set(newRoleIds);
  const removeUnverified = unverifiedRoleIds.filter((id) => newSet.has(id));
  return { verify: true, removeUnverified };
}

async function execute(oldMember, newMember) {
  if (!newMember || newMember.user?.bot) return;

  const guildId = newMember.guild.id;

  const verifiedRoleIds = await config.getVerifiedRoleIds(guildId);
  if (verifiedRoleIds.length === 0) return; // feature not configured

  const unverifiedRoleIds = await config.getUnverifiedRoleIds(guildId);

  const oldPartial = oldMember?.partial === true;
  const oldRoleIds = oldPartial ? [] : [...(oldMember?.roles?.cache?.keys() ?? [])];
  const newRoleIds = [...(newMember.roles?.cache?.keys() ?? [])];

  const { verify, removeUnverified } = decideVerification({
    isBot: false,
    oldRoleIds,
    newRoleIds,
    verifiedRoleIds,
    unverifiedRoleIds,
    oldPartial,
  });
  if (!verify) return;

  // 1. Clear the verification deadline so the background sweep won't kick them.
  await verifications.markVerified(guildId, newMember.id).catch((err) =>
    console.error('[manual-verify] markVerified failed:', err));

  // 2. Strip the unverified role(s) so the state matches a captcha-verified member.
  for (const rId of removeUnverified) {
    const role = newMember.guild.roles.cache.get(rId)
      || await newMember.guild.roles.fetch(rId).catch(() => null);
    if (role) {
      await newMember.roles.remove(role, 'Oreo: Manuell verifiziert').catch((err) =>
        console.error('[manual-verify] removing unverified role failed:', err));
    }
  }
}

module.exports = { name: Events.GuildMemberUpdate, execute, _internal: { decideVerification } };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/smoke/manual_verify.js`
Expected: `manual_verify smoke OK`

(Note: `node tests/smoke/manual_verify.js` runs standalone and needs **no** MySQL. The full `npm test` battery needs a reachable MySQL and may be unavailable locally — running this single file is sufficient for this task.)

- [ ] **Step 5: Commit**

```bash
git add src/events/guildMemberUpdate.js tests/smoke/manual_verify.js
git commit -m "feat: treat manual verified-role assignment as verified"
```

---

### Task 2: CLAUDE.md aktualisieren (Maintenance-Rule)

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the shipped behavior from Task 1 (handler name, files, `decideVerification`).
- Produces: documentation only — no code.

- [ ] **Step 1: Add a new invariant (append as item 19 in "Critical invariants")**

Insert after invariant 18, before the "## Layout" section:

```markdown
19. **Manual verified-role = verified** (`src/events/guildMemberUpdate.js`): when a **non-bot** member has a `verified_role_ids` role **newly** added (manual mod assignment), Oreo treats them as verified — it calls `verifications.markVerified(guildId, userId)` (clears the `pending_verifications` deadline so the `background.js` sweep can't kick them, invariant 15) and removes any `unverified_role_ids` the member currently has (`.remove(..., 'Oreo: Manuell verifiziert')`, best-effort). The decision lives in the pure `_internal.decideVerification({ isBot, oldRoleIds, newRoleIds, verifiedRoleIds, unverifiedRoleIds, oldPartial })` → `{ verify, removeUnverified }`. No loop: stripping the unverified role fires another `GuildMemberUpdate`, but no verified role is *newly* added there (`hadVerifiedBefore` is true), so `decideVerification` returns `verify: false`. A partial `oldMember` (uncached) is reconciled unconditionally (idempotent, since `markVerified` is a no-op DELETE). Bots never reach this (`newMember.user.bot` early-return). No modlog entry is written.
```

- [ ] **Step 2: Add the handler to the "## Layout" section**

Under `src/events/*.js`, the file count changes from 21 to 22 event handlers. Update the count in the Layout block's `src/events/*.js` line from `21 gateway event handlers` to `22 gateway event handlers`, and add a one-line entry describing the new file after the `src/composables/verifyChannel.js` line group (or in the events grouping):

```
src/events/guildMemberUpdate.js  manual verified-role → mark verified + strip unverified (invariant 19)
```

- [ ] **Step 3: Add a Testing-section line**

In the "## Testing" section's smoke-test enumeration, add:

```
manual verified-role reconciliation (`tests/smoke/manual_verify.js`, no DB — pure `decideVerification`: verified-newly-added → verify+strip-unverified, no-verified → noop, bot → noop, already-verified → noop, partial-old → reconcile; see invariant 19)
```

Also update the standalone count if the Layout says "20 smoke tests" / "tests/run.js ... 20 smoke tests" → 21.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document manual verified-role invariant (guildMemberUpdate)"
```

---

## Notes for the implementer

- **Branch:** work happens on `feature/manual-verify-role` (already created; the spec commit is `42e4256`). Do NOT switch to `main`.
- **No `index.js` change:** `loadEvents.js` auto-loads every `src/events/*.js` that exports `{ name, execute }` and wraps `execute` in `.catch()`. The handler needs nothing wired manually.
- **Why a pure core:** `config`/`verifications` hit MySQL, so the branchy logic is factored into `decideVerification` to keep the smoke test DB-free — matching Oreo's `_internal` test-seam pattern (e.g. `captcha._internal`, `announcement._internal.truncateForDiff`).
- **Idempotency:** `markVerified` is a `DELETE ... WHERE` (no-op when no row); `roles.remove` is best-effort — running the reconcile twice is harmless, which is why the partial-old path is safe.
