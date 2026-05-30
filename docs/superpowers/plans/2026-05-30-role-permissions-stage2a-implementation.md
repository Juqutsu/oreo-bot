# Role-Permissions (Stage 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tier-basiertes Permission-System (`helper`/`mod`/`admin`) etablieren, mit `/setup` als owner-only Bootstrap und `/config role` als Live-Editor. Alle 11 bestehenden Commands werden migriert.

**Architecture:** Neues Modul `src/perms.js` mit Resolver + Middleware-Helper. Tier-Check läuft im `InteractionCreate`-Handler von `index.js` vor jedem `command.execute()`. Commands deklarieren `requiredTier` als Export-Feld. `setDefaultMemberPermissions(...)` wird aus allen Mod-Commands entfernt — Tier-Middleware ist der einzige Gate. `/setup` ist owner-gated (kein Tier-Check, weil Tabelle initial leer).

**Tech Stack:** Node.js (CommonJS), discord.js v14.26, mysql2/promise, MySQL 8.x.

**Spec:** [docs/superpowers/specs/2026-05-30-role-permissions-stage2a-design.md](../specs/2026-05-30-role-permissions-stage2a-design.md)

**Branch:** `feat/role-permissions-stage2a` (neuer Branch von `main`, **nachdem** Stage 1.5 / `feat/warn-cases-stage1` gemerged ist).

**Testing-Hinweis:** Keine Test-Suite (per Projekt-Konvention seit Stage 1). Smoke-Tests pro Repository-/Resolver-Task gegen Docker MySQL + manuelle Verifikation in Task 9.

---

## File Structure

**Zu erstellen:**
- `src/perms.js` — Tier-Resolver + Middleware-Helper
- `src/commands/setup.js` — Owner-only Bootstrap-Command
- `src/commands/config.js` — Subcommand-Group `role` mit `set`/`unset`/`list`

**Zu editieren:**
- `index.js` — Tier-Check vor `command.execute()` im InteractionCreate-Handler
- `src/commands/ping.js` — `requiredTier: 'helper'` + `setDefaultMemberPermissions` raus
- `src/commands/warnings.js` — `requiredTier: 'helper'` + `setDefaultMemberPermissions` raus
- `src/commands/modhistory.js` — `requiredTier: 'helper'` + `setDefaultMemberPermissions` raus
- `src/commands/case.js` — `requiredTier: 'helper'` + `setDefaultMemberPermissions` raus
- `src/commands/warn.js` — `requiredTier: 'mod'` + `setDefaultMemberPermissions` raus
- `src/commands/timeout.js` — `requiredTier: 'mod'` + `setDefaultMemberPermissions` raus
- `src/commands/untimeout.js` — `requiredTier: 'mod'` + `setDefaultMemberPermissions` raus
- `src/commands/removewarn.js` — `requiredTier: 'mod'` + `setDefaultMemberPermissions` raus
- `src/commands/reason.js` — `requiredTier: 'mod'` + `setDefaultMemberPermissions` raus
- `src/commands/ban.js` — `requiredTier: 'admin'` + `setDefaultMemberPermissions` raus
- `src/commands/unban.js` — `requiredTier: 'admin'` + `setDefaultMemberPermissions` raus
- `src/commands/kick.js` — `requiredTier: 'admin'` + `setDefaultMemberPermissions` raus

**Schema:** Keine Änderungen. `role_permissions` existiert seit Stage 1.

---

## Task 0: Branch-Vorbereitung

**Files:** keine

- [ ] **Step 1: Vorbedingung prüfen — Stage 1.5 muss gemerged sein**

Run:
```bash
git fetch origin main
git log --oneline origin/main -5
```

Expected: Die letzten Stage-1.5-Commits (z.B. `docs(commands): document intentional TOCTOU window in /reason`) müssen auf `origin/main` sichtbar sein. Falls nicht: STOP — erst Stage 1.5 als PR mergen.

- [ ] **Step 2: Neuen Branch von frischem main erstellen**

Run:
```bash
git checkout main
git pull origin main
git checkout -b feat/role-permissions-stage2a
```

Expected: `On branch feat/role-permissions-stage2a`.

---

## Task 1: `src/perms.js` — Resolver + Middleware-Helper

**Files:**
- Create: `src/perms.js`

- [ ] **Step 1: Datei mit Tier-Konstanten und API anlegen**

Write `src/perms.js`:

```js
const { MessageFlags } = require('discord.js');
const { getPool } = require('./db');

const TIERS = {
  helper: 1,
  mod: 2,
  admin: 3,
};

/**
 * Liefert den höchsten Tier, den ein Member über seine Rollen hat.
 * Server-Owner hat KEINEN Sonderstatus (Single Source of Truth = role_permissions).
 * @param {string} guildId
 * @param {import('discord.js').GuildMember|null} member
 * @returns {Promise<'helper'|'mod'|'admin'|null>}
 */
async function getEffectiveTier(guildId, member) {
  if (!member) return null;

  const [rows] = await getPool().execute(
    'SELECT role_id, permission FROM role_permissions WHERE guild_id = ?',
    [guildId],
  );
  const tierByRole = new Map(rows.map((r) => [String(r.role_id), r.permission]));

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
}

/**
 * Prüft ob Member mindestens den geforderten Tier hat.
 * @returns {Promise<boolean>}
 */
async function hasTier(guildId, member, requiredTier) {
  const effective = await getEffectiveTier(guildId, member);
  if (!effective) return false;
  return TIERS[effective] >= TIERS[requiredTier];
}

/**
 * Middleware-Helper: prüft Tier, antwortet ephemeral wenn nicht erlaubt.
 * Bei DB-Failure: ephemeral "Datenbankfehler" + return false + console.error.
 * @returns {Promise<boolean>}  true wenn erlaubt, false wenn schon geantwortet
 */
async function requireTier(interaction, requiredTier) {
  const member = interaction.member;
  if (!member) {
    await interaction.reply({
      content: 'Member nicht gefunden — versuch es nochmal.',
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  let allowed;
  try {
    allowed = await hasTier(interaction.guildId, member, requiredTier);
  } catch (err) {
    console.error('[perms] requireTier DB error:', err);
    await interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  if (!allowed) {
    await interaction.reply({
      content: `Du brauchst Tier '${requiredTier}' oder höher für diesen Befehl.`,
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }
  return true;
}

module.exports = {
  TIERS,
  getEffectiveTier,
  hasTier,
  requireTier,
};
```

- [ ] **Step 2: Syntax-Check**

Run:
```bash
node -e "require('./src/perms.js'); console.log('perms loaded OK')"
```

Expected: `perms loaded OK`.

- [ ] **Step 3: Smoke-Test gegen Docker MySQL**

Write a temp script `_smoke_perms.js` in repo root:

```js
require('dotenv').config({ path: '.env' });
const perms = require('./src/perms');
const { getPool } = require('./src/db');

(async () => {
  const guildId = '123456789';
  const pool = getPool();

  // Reset Test-Daten
  await pool.execute('DELETE FROM role_permissions WHERE guild_id = ?', [guildId]);
  await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [guildId]);
  await pool.execute(
    "INSERT INTO role_permissions (guild_id, role_id, permission) VALUES (?, '111', 'admin'), (?, '222', 'mod'), (?, '333', 'helper')",
    [guildId, guildId, guildId],
  );

  // Stub-Member mit roles.cache
  const member = (roleIds) => ({
    roles: { cache: new Map(roleIds.map((id) => [id, { id }])) },
  });

  console.log('admin role →', await perms.getEffectiveTier(guildId, member(['111'])));    // 'admin'
  console.log('mod+helper →', await perms.getEffectiveTier(guildId, member(['222','333'])));  // 'mod' (höchster)
  console.log('unknown →',   await perms.getEffectiveTier(guildId, member(['999'])));    // null
  console.log('no roles →',  await perms.getEffectiveTier(guildId, member([])));         // null
  console.log('null member→', await perms.getEffectiveTier(guildId, null));              // null
  console.log('hasTier admin>=mod →', await perms.hasTier(guildId, member(['111']), 'mod'));   // true
  console.log('hasTier mod>=admin →', await perms.hasTier(guildId, member(['222']), 'admin')); // false
  console.log('hasTier helper>=helper →', await perms.hasTier(guildId, member(['333']), 'helper')); // true

  // Cleanup
  await pool.execute('DELETE FROM role_permissions WHERE guild_id = ?', [guildId]);
  await pool.execute('DELETE FROM guilds WHERE guild_id = ?', [guildId]);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
```

Run:
```bash
node --env-file=.env _smoke_perms.js
```

Expected output (alle Lines):
```
admin role → admin
mod+helper → mod
unknown → null
no roles → null
null member→ null
hasTier admin>=mod → true
hasTier mod>=admin → false
hasTier helper>=helper → true
```

- [ ] **Step 4: Temp-Skript löschen**

Run:
```bash
rm _smoke_perms.js
```

- [ ] **Step 5: Commit**

```bash
git add src/perms.js
git commit -m "feat(perms): add tier resolver and requireTier middleware-helper"
```

---

## Task 2: Middleware in `index.js` einbauen

**Files:**
- Modify: `index.js`

- [ ] **Step 1: `perms`-Import hinzufügen**

Edit `index.js` — finde:

old_string:
```js
const { loadCommands } = require('./src/loadCommands');
const { deployCommands } = require('./src/deployCommands');
const { ping: pingDb } = require('./src/db');
const { ensureSchema } = require('./src/schema');
```

new_string:
```js
const { loadCommands } = require('./src/loadCommands');
const { deployCommands } = require('./src/deployCommands');
const { ping: pingDb } = require('./src/db');
const { ensureSchema } = require('./src/schema');
const perms = require('./src/perms');
```

- [ ] **Step 2: Tier-Check in InteractionCreate-Handler einbauen**

Edit `index.js` — finde:

old_string:
```js
  if (!interaction.isChatInputCommand()) return;

  try {
    await command.execute(interaction);
  } catch (err) {
```

new_string:
```js
  if (!interaction.isChatInputCommand()) return;

  if (command.requiredTier) {
    let allowed;
    try {
      allowed = await perms.requireTier(interaction, command.requiredTier);
    } catch (err) {
      console.error(`Tier-Check für "${interaction.commandName}" fehlgeschlagen:`, err);
      return;
    }
    if (!allowed) {
      console.info(`[perms] ${interaction.user.tag} blocked from /${interaction.commandName} (tier required: ${command.requiredTier})`);
      return;
    }
  }

  try {
    await command.execute(interaction);
  } catch (err) {
```

- [ ] **Step 3: Syntax-Check**

Run:
```bash
node -c index.js
```

Expected: kein Output (Datei syntaktisch valid).

- [ ] **Step 4: Smoke-Test — Bot startet ohne Crash**

Mit Docker MySQL laufend:

Run:
```bash
timeout 10 node --env-file=.env index.js || true
```

Expected: Logs zeigen `MySQL reachable.` → `Schema sichergestellt.` → `Logged in as Oreo#... (N command(s) loaded)`. Bot crasht NICHT. Nach 10 Sekunden killt timeout den Prozess.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(perms): wire tier-check middleware into InteractionCreate handler"
```

---

## Task 3: `/setup`-Command

**Files:**
- Create: `src/commands/setup.js`

- [ ] **Step 1: Command-File anlegen**

Write `src/commands/setup.js`:

```js
const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { getPool } = require('../db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Initialer Bootstrap der role_permissions (nur Server-Owner).')
    .addRoleOption((o) => o.setName('admin-role').setDescription('Rolle für Tier admin').setRequired(true))
    .addRoleOption((o) => o.setName('mod-role').setDescription('Rolle für Tier mod').setRequired(false))
    .addRoleOption((o) => o.setName('helper-role').setDescription('Rolle für Tier helper').setRequired(false))
    .setDefaultMemberPermissions(0),

  // KEIN requiredTier — Bootstrap muss laufen, wenn role_permissions leer ist.
  // Gate: Server-Owner-ID.

  async execute(interaction) {
    if (interaction.user.id !== interaction.guild.ownerId) {
      return interaction.reply({
        content: 'Nur der Server-Inhaber kann /setup ausführen.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const adminRole = interaction.options.getRole('admin-role');
    const modRole = interaction.options.getRole('mod-role');
    const helperRole = interaction.options.getRole('helper-role');

    const assignments = [
      { role: adminRole, tier: 'admin' },
      { role: modRole, tier: 'mod' },
      { role: helperRole, tier: 'helper' },
    ].filter((a) => a.role !== null);

    // Validation: @everyone
    for (const a of assignments) {
      if (a.role.id === interaction.guildId) {
        return interaction.reply({
          content: 'Die @everyone-Rolle kann nicht zugewiesen werden.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (a.role.managed) {
        return interaction.reply({
          content: 'Bot-/Integration-Rollen können nicht zugewiesen werden.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    // Validation: doppelte Rolle
    const roleIds = assignments.map((a) => a.role.id);
    if (new Set(roleIds).size !== roleIds.length) {
      return interaction.reply({
        content: 'Eine Rolle kann nicht mehreren Tiers zugewiesen werden.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [interaction.guildId]);
      await conn.execute('DELETE FROM role_permissions WHERE guild_id = ?', [interaction.guildId]);
      for (const a of assignments) {
        await conn.execute(
          'INSERT INTO role_permissions (guild_id, role_id, permission) VALUES (?, ?, ?)',
          [interaction.guildId, a.role.id, a.tier],
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      console.error('/setup DB error:', err);
      return interaction.reply({
        content: 'Datenbankfehler — versuch es später.',
        flags: MessageFlags.Ephemeral,
      });
    } finally {
      conn.release();
    }

    const embed = new EmbedBuilder()
      .setTitle('✅ Setup abgeschlossen')
      .setColor(0x57f287)
      .addFields(
        { name: 'Admin',  value: adminRole  ? `<@&${adminRole.id}>`  : '(nicht gesetzt)', inline: false },
        { name: 'Mod',    value: modRole    ? `<@&${modRole.id}>`    : '(nicht gesetzt)', inline: false },
        { name: 'Helper', value: helperRole ? `<@&${helperRole.id}>` : '(nicht gesetzt)', inline: false },
      )
      .setFooter({ text: `${assignments.length} Rollen konfiguriert · weitere via /config role set · 🐾` });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
```

- [ ] **Step 2: Syntax-Check**

Run:
```bash
node -c src/commands/setup.js
```

Expected: kein Output.

- [ ] **Step 3: Commit**

```bash
git add src/commands/setup.js
git commit -m "feat(commands): add /setup for owner-only role-permissions bootstrap"
```

---

## Task 4: `/config role`-Subcommands

**Files:**
- Create: `src/commands/config.js`

- [ ] **Step 1: Command-File anlegen**

Write `src/commands/config.js`:

```js
const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { getPool } = require('../db');

const TIER_CHOICES = [
  { name: 'helper', value: 'helper' },
  { name: 'mod',    value: 'mod'    },
  { name: 'admin',  value: 'admin'  },
];

const TIER_ORDER = ['admin', 'mod', 'helper'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Konfiguration des Bots für diesen Server.')
    .setDefaultMemberPermissions(0)
    .addSubcommandGroup((group) =>
      group.setName('role').setDescription('Rollen-Tier-Verwaltung')
        .addSubcommand((sub) =>
          sub.setName('set').setDescription('Weist einer Rolle einen Tier zu.')
            .addRoleOption((o) => o.setName('role').setDescription('Rolle').setRequired(true))
            .addStringOption((o) => o.setName('tier').setDescription('Tier').setRequired(true).addChoices(...TIER_CHOICES))
        )
        .addSubcommand((sub) =>
          sub.setName('unset').setDescription('Entfernt den Tier einer Rolle.')
            .addRoleOption((o) => o.setName('role').setDescription('Rolle').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub.setName('list').setDescription('Zeigt alle Rollen-Tier-Zuweisungen.')
        )
    ),

  requiredTier: 'admin',

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    if (group !== 'role') {
      return interaction.reply({
        content: 'Unbekannter Subcommand.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'set')   return handleRoleSet(interaction);
    if (sub === 'unset') return handleRoleUnset(interaction);
    if (sub === 'list')  return handleRoleList(interaction);
  },
};

async function handleRoleSet(interaction) {
  const role = interaction.options.getRole('role');
  const tier = interaction.options.getString('tier');

  if (role.id === interaction.guildId) {
    return interaction.reply({
      content: 'Die @everyone-Rolle kann nicht zugewiesen werden.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (role.managed) {
    return interaction.reply({
      content: 'Bot-/Integration-Rollen können nicht zugewiesen werden.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const pool = getPool();
  let previousTier = null;
  try {
    await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [interaction.guildId]);
    const [existing] = await pool.execute(
      'SELECT permission FROM role_permissions WHERE guild_id = ? AND role_id = ?',
      [interaction.guildId, role.id],
    );
    previousTier = existing[0]?.permission ?? null;

    await pool.execute(
      `INSERT INTO role_permissions (guild_id, role_id, permission)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE permission = VALUES(permission)`,
      [interaction.guildId, role.id, tier],
    );
  } catch (err) {
    console.error('/config role set DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  let message;
  if (previousTier === tier) {
    message = `Rolle <@&${role.id}> war bereits Tier '${tier}'.`;
  } else if (previousTier) {
    message = `Rolle <@&${role.id}> wurde von Tier '${previousTier}' auf '${tier}' geändert.`;
  } else {
    message = `Rolle <@&${role.id}> hat jetzt Tier '${tier}'.`;
  }

  return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}

async function handleRoleUnset(interaction) {
  const role = interaction.options.getRole('role');
  const conn = await getPool().getConnection();

  try {
    await conn.beginTransaction();

    const [delResult] = await conn.execute(
      'DELETE FROM role_permissions WHERE guild_id = ? AND role_id = ?',
      [interaction.guildId, role.id],
    );

    if (delResult.affectedRows === 0) {
      await conn.rollback();
      return interaction.reply({
        content: `Rolle <@&${role.id}> hatte keinen Tier — nichts zu tun.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Lockout-Schutz: wenn keine admin-Rolle mehr UND User ist nicht Owner → Rollback
    const [adminRows] = await conn.execute(
      'SELECT COUNT(*) AS n FROM role_permissions WHERE guild_id = ? AND permission = ? FOR UPDATE',
      [interaction.guildId, 'admin'],
    );
    const adminCount = Number(adminRows[0].n);
    const isOwner = interaction.user.id === interaction.guild.ownerId;

    if (adminCount === 0 && !isOwner) {
      await conn.rollback();
      return interaction.reply({
        content: "Abbruch — das wäre die letzte Admin-Rolle. Setze erst eine andere Rolle auf 'admin' oder lass den Server-Owner das machen.",
        flags: MessageFlags.Ephemeral,
      });
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error('/config role unset DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  } finally {
    conn.release();
  }

  return interaction.reply({
    content: `Rolle <@&${role.id}> hat keinen Tier mehr (entfernt).`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleRoleList(interaction) {
  let rows;
  try {
    [rows] = await getPool().execute(
      'SELECT role_id, permission FROM role_permissions WHERE guild_id = ?',
      [interaction.guildId],
    );
  } catch (err) {
    console.error('/config role list DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (rows.length === 0) {
    return interaction.reply({
      content: 'Keine Rollen konfiguriert. Nutze /setup oder /config role set.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const byTier = { admin: [], mod: [], helper: [] };
  for (const row of rows) {
    const roleId = String(row.role_id);
    const stillExists = interaction.guild.roles.cache.has(roleId);
    const display = stillExists ? `<@&${roleId}>` : `<@&${roleId}> ⚠️ (gelöscht)`;
    byTier[row.permission].push(display);
  }

  const embed = new EmbedBuilder()
    .setTitle('🛡️ Permission-Konfiguration')
    .setColor(0x5865f2);

  for (const tier of TIER_ORDER) {
    const entries = byTier[tier];
    embed.addFields({
      name: tier.toUpperCase(),
      value: entries.length > 0 ? entries.join('\n') : '—',
      inline: false,
    });
  }

  embed.setFooter({ text: '🐾 Oreo' });

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
```

- [ ] **Step 2: Syntax-Check**

Run:
```bash
node -c src/commands/config.js
```

Expected: kein Output.

- [ ] **Step 3: Smoke-Test (Lockout-Schutz isoliert)**

Write `_smoke_config.js`:

```js
require('dotenv').config({ path: '.env' });
const { getPool } = require('./src/db');

(async () => {
  const pool = getPool();
  const guildId = '123456789';
  const ownerId = '999999';
  const otherAdminId = '111111';

  // Setup: 1 admin-Rolle
  await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [guildId]);
  await pool.execute('DELETE FROM role_permissions WHERE guild_id = ?', [guildId]);
  await pool.execute(
    "INSERT INTO role_permissions (guild_id, role_id, permission) VALUES (?, '111', 'admin')",
    [guildId],
  );

  // Simulation: nicht-Owner versucht letzte admin-Rolle zu entziehen
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  const [del] = await conn.execute(
    'DELETE FROM role_permissions WHERE guild_id = ? AND role_id = ?',
    [guildId, '111'],
  );
  const [adminRows] = await conn.execute(
    "SELECT COUNT(*) AS n FROM role_permissions WHERE guild_id = ? AND permission = 'admin' FOR UPDATE",
    [guildId],
  );
  const adminCount = Number(adminRows[0].n);

  console.log('deleted:', del.affectedRows, '(expected 1)');
  console.log('admin_count nach DELETE:', adminCount, '(expected 0)');
  console.log('lockout würde getriggert für non-owner:', adminCount === 0 && otherAdminId !== ownerId, '(expected true)');

  await conn.rollback();
  conn.release();

  // Verify nach Rollback: admin-Rolle ist noch da
  const [verify] = await pool.execute(
    "SELECT COUNT(*) AS n FROM role_permissions WHERE guild_id = ? AND permission = 'admin'",
    [guildId],
  );
  console.log('admin-Rolle nach Rollback:', Number(verify[0].n), '(expected 1)');

  // Cleanup
  await pool.execute('DELETE FROM role_permissions WHERE guild_id = ?', [guildId]);
  await pool.execute('DELETE FROM guilds WHERE guild_id = ?', [guildId]);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
```

Run:
```bash
node --env-file=.env _smoke_config.js
```

Expected:
```
deleted: 1 (expected 1)
admin_count nach DELETE: 0 (expected 0)
lockout würde getriggert für non-owner: true (expected true)
admin-Rolle nach Rollback: 1 (expected 1)
```

- [ ] **Step 4: Temp-Skript löschen**

Run:
```bash
rm _smoke_config.js
```

- [ ] **Step 5: Commit**

```bash
git add src/commands/config.js
git commit -m "feat(commands): add /config role set/unset/list with lockout protection"
```

---

## Task 5: Helper-Tier Migration — `ping`, `warnings`, `modhistory`, `case`

**Files:**
- Modify: `src/commands/ping.js`
- Modify: `src/commands/warnings.js`
- Modify: `src/commands/modhistory.js`
- Modify: `src/commands/case.js`

**Migrations-Pattern (auf alle vier Dateien angewendet):**

Drei Änderungen pro Datei:

1. `PermissionFlagsBits` aus dem `require('discord.js')`-Destructuring entfernen, falls nach Schritt 2 ungenutzt.
2. Die Zeile `.setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)` komplett entfernen (Sonderfall `ping.js`: existiert dort gar nicht — Schritt 1 und 2 entfallen).
3. `requiredTier: 'helper',` nach `data: …,` und vor `async execute(interaction)` einfügen.

Beispiel-Diff (für `warnings.js`, der den vollständigen Pattern hat):

```diff
-const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
+const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
 const cases = require('../cases');

 module.exports = {
   data: new SlashCommandBuilder()
     .setName('warnings')
     .setDescription('Zeigt die Warnungen eines Users.')
     .addUserOption((o) => o.setName('user').setDescription('Welcher User?').setRequired(true))
-    .addBooleanOption((o) => o.setName('include_inactive').setDescription('Auch entfernte?').setRequired(false))
-    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
+    .addBooleanOption((o) => o.setName('include_inactive').setDescription('Auch entfernte?').setRequired(false)),
+  requiredTier: 'helper',

   async execute(interaction) {
```

Sonderfall `ping.js` — hat nur:

```js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Prüft, ob Oreo wach ist.'),

  async execute(interaction) { ... },
};
```

→ Nur `requiredTier: 'helper',` nach `data: …,` einfügen. Keine Imports anfassen.

- [ ] **Step 1: `src/commands/ping.js` migrieren**

Sonderfall ohne `setDefaultMemberPermissions`. Nur `requiredTier: 'helper',` nach `data: …,` einfügen:

```diff
   data: new SlashCommandBuilder()
     .setName('ping')
     .setDescription('Prüft, ob Oreo wach ist.'),
+  requiredTier: 'helper',

   async execute(interaction) {
```

- [ ] **Step 2: `src/commands/warnings.js` migrieren**

Vollständiges Pattern oben anwenden. Tier: `'helper'`.

- [ ] **Step 3: `src/commands/modhistory.js` migrieren**

Vollständiges Pattern oben anwenden. Tier: `'helper'`.

- [ ] **Step 4: `src/commands/case.js` migrieren**

Vollständiges Pattern oben anwenden. Tier: `'helper'`. Achtung: case.js hat zusätzlich `EmbedBuilder` und nutzt es — der Destructuring-Import bleibt nach Entfernen von `PermissionFlagsBits` erhalten.

- [ ] **Step 5: Syntax-Check für alle vier**

Run:
```bash
node -c src/commands/ping.js && node -c src/commands/warnings.js && node -c src/commands/modhistory.js && node -c src/commands/case.js
```

Expected: kein Output.

- [ ] **Step 6: Smoke-Test — alle vier laden korrekt mit `requiredTier`**

Run:
```bash
node -e "
const fs = require('fs'), path = require('path');
for (const f of ['ping','warnings','modhistory','case']) {
  const c = require('./src/commands/' + f);
  console.log(f, '→ requiredTier:', c.requiredTier, '(expected helper)');
  const json = c.data.toJSON();
  console.log(f, '→ default_member_permissions:', json.default_member_permissions, '(expected null/undefined)');
}
"
```

Expected: alle vier zeigen `requiredTier: helper` und `default_member_permissions: null` (oder `undefined`).

- [ ] **Step 7: Commit**

```bash
git add src/commands/ping.js src/commands/warnings.js src/commands/modhistory.js src/commands/case.js
git commit -m "feat(perms): migrate helper-tier commands (ping, warnings, modhistory, case)"
```

---

## Task 6: Mod-Tier Migration — `warn`, `timeout`, `untimeout`, `removewarn`, `reason`

**Files:**
- Modify: `src/commands/warn.js`
- Modify: `src/commands/timeout.js`
- Modify: `src/commands/untimeout.js`
- Modify: `src/commands/removewarn.js`
- Modify: `src/commands/reason.js`

**Migrations-Pattern (auf alle fünf Dateien angewendet):**

Jede Datei hat aktuell `setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)` im SlashCommandBuilder. Drei Änderungen pro Datei:

1. `PermissionFlagsBits` aus dem `require('discord.js')`-Destructuring entfernen (in allen fünf nicht mehr nötig nach Schritt 2).
2. Die Zeile `.setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)` (mit oder ohne trailing `,`) komplett entfernen.
3. `requiredTier: 'mod',` nach `data: …,` und vor `async execute(interaction)` einfügen.

Beispiel-Diff (für `warn.js`):

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

**Geschäftslogik bleibt unverändert in allen Mod-Commands** (separater Schutz-Layer):
- Self-target-Check (`target.id === moderator.id`)
- Bot-self-Check (`target.id === botMember.id`)
- Owner-Schutz (`target.id === interaction.guild.ownerId`)
- Rollen-Hierarchie-Check (`moderator.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0`)
- Discord-Capability-Checks (`.moderatable` in timeout/untimeout, `.bannable` in ban etc.)

- [ ] **Step 1: `src/commands/warn.js` migrieren**

Anwendung des Patterns oben auf `warn.js`. Tier: `'mod'`.

- [ ] **Step 2: `src/commands/timeout.js` migrieren**

Anwendung des Patterns auf `timeout.js`. Tier: `'mod'`. **Achtung:** die `setDefaultMemberPermissions(...)`-Zeile hat hier KEIN trailing Komma (ist die letzte Zeile des Builders) — die Zeile davor muss am Ende ein Komma bekommen, falls keine neue Builder-Method folgt. `.moderatable`-Check bleibt unverändert.

- [ ] **Step 3: `src/commands/untimeout.js` migrieren**

Anwendung des Patterns auf `untimeout.js`. Tier: `'mod'`. `.moderatable`-Check bleibt.

- [ ] **Step 4: `src/commands/removewarn.js` migrieren**

Anwendung des Patterns auf `removewarn.js`. Tier: `'mod'`. Case-Validierungen (Existenz, Type, Active-Flag) bleiben unverändert.

- [ ] **Step 5: `src/commands/reason.js` migrieren**

Anwendung des Patterns auf `reason.js`. Tier: `'mod'`. Meta-Case-Schutz (Type != warn_removed/reason_edited) bleibt unverändert.

- [ ] **Step 6: Syntax-Check für alle fünf**

Run:
```bash
node -c src/commands/warn.js && node -c src/commands/timeout.js && node -c src/commands/untimeout.js && node -c src/commands/removewarn.js && node -c src/commands/reason.js
```

Expected: kein Output.

- [ ] **Step 7: Smoke-Test — Tier korrekt + keine Default-Perms**

Run:
```bash
node -e "
for (const f of ['warn','timeout','untimeout','removewarn','reason']) {
  const c = require('./src/commands/' + f);
  console.log(f, '→ requiredTier:', c.requiredTier, '(expected mod)');
  console.log(f, '→ default_member_permissions:', c.data.toJSON().default_member_permissions, '(expected null/undefined)');
}
"
```

Expected: alle fünf `requiredTier: mod`, `default_member_permissions: null`.

- [ ] **Step 8: Commit**

```bash
git add src/commands/warn.js src/commands/timeout.js src/commands/untimeout.js src/commands/removewarn.js src/commands/reason.js
git commit -m "feat(perms): migrate mod-tier commands (warn, timeout, untimeout, removewarn, reason)"
```

---

## Task 7: Admin-Tier Migration — `ban`, `unban`, `kick`

**Files:**
- Modify: `src/commands/ban.js`
- Modify: `src/commands/unban.js`
- Modify: `src/commands/kick.js`

**Migrations-Pattern (auf alle drei Dateien angewendet):**

Drei Änderungen pro Datei:

1. `PermissionFlagsBits` aus dem `require('discord.js')`-Destructuring entfernen (in allen drei nicht mehr nötig nach Schritt 2).
2. Die Zeile `.setDefaultMemberPermissions(PermissionFlagsBits.<Perm>)` komplett entfernen — `<Perm>` ist `BanMembers` (ban, unban) bzw. `KickMembers` (kick).
3. `requiredTier: 'admin',` nach `data: …,` und vor `async execute(interaction)` einfügen.

Beispiel-Diff (für `ban.js`):

```diff
-const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
+const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
 const cases = require('../cases');

 module.exports = {
   data: new SlashCommandBuilder()
     .setName('ban')
     .setDescription('Bannt einen Nutzer vom Server.')
     .addUserOption((option) => option.setName('target').setDescription('Wer soll gebannt werden?').setRequired(true))
-    .addStringOption((reason) => reason.setName('reason').setDescription('Grund für den Ban').setRequired(false))
-    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
+    .addStringOption((reason) => reason.setName('reason').setDescription('Grund für den Ban').setRequired(false)),
+  requiredTier: 'admin',

   async execute(interaction) {
```

**Geschäftslogik bleibt unverändert:**
- Self-target-Check, Bot-self-Check, Owner-Schutz, Rollen-Hierarchie-Check
- Discord-Capability-Checks (`.bannable` für ban, `.kickable` für kick)
- unban: hat `autocomplete`-Function für ban-User-Suche — bleibt unverändert

- [ ] **Step 1: `src/commands/ban.js` migrieren**

Anwendung des Patterns auf `ban.js`. `<Perm>` ist `BanMembers`. `.bannable`-Check bleibt.

- [ ] **Step 2: `src/commands/unban.js` migrieren**

Anwendung des Patterns auf `unban.js`. `<Perm>` ist `BanMembers`. Die `autocomplete`-Function (für gebannte-User-Suche) bleibt unverändert.

- [ ] **Step 3: `src/commands/kick.js` migrieren**

Anwendung des Patterns auf `kick.js`. `<Perm>` ist `KickMembers`. `.kickable`-Check bleibt.

- [ ] **Step 4: Syntax-Check für alle drei**

Run:
```bash
node -c src/commands/ban.js && node -c src/commands/unban.js && node -c src/commands/kick.js
```

Expected: kein Output.

- [ ] **Step 5: Smoke-Test — Tier korrekt + keine Default-Perms**

Run:
```bash
node -e "
for (const f of ['ban','unban','kick']) {
  const c = require('./src/commands/' + f);
  console.log(f, '→ requiredTier:', c.requiredTier, '(expected admin)');
  console.log(f, '→ default_member_permissions:', c.data.toJSON().default_member_permissions, '(expected null/undefined)');
}
"
```

Expected: alle drei `requiredTier: admin`, `default_member_permissions: null`.

- [ ] **Step 6: Commit**

```bash
git add src/commands/ban.js src/commands/unban.js src/commands/kick.js
git commit -m "feat(perms): migrate admin-tier commands (ban, unban, kick)"
```

---

## Task 8: Integration-Smoke-Test — alle Commands laden konsistent

**Files:** keine

- [ ] **Step 1: Alle 13 Commands haben `requiredTier` (außer `/setup`)**

Run:
```bash
node -e "
const { loadCommands } = require('./src/loadCommands');
const commands = loadCommands();
let ok = true;
for (const [name, cmd] of commands) {
  if (name === 'setup') {
    if (cmd.requiredTier) { console.error('FAIL: /setup hat requiredTier — sollte nicht'); ok = false; }
    else console.log('setup: kein requiredTier (korrekt — Owner-Gate)');
    continue;
  }
  if (!cmd.requiredTier) { console.error('FAIL:', name, 'hat keinen requiredTier'); ok = false; }
  else console.log(name, '→', cmd.requiredTier);
}
process.exit(ok ? 0 : 1);
"
```

Expected: jeder Command zeigt seinen Tier, `setup` zeigt 'kein requiredTier (korrekt)'. Exit-Code 0.

- [ ] **Step 2: Kein Command (außer `/setup` und `/config`) hat noch `default_member_permissions`**

Run:
```bash
node -e "
const { loadCommands } = require('./src/loadCommands');
const commands = loadCommands();
let ok = true;
for (const [name, cmd] of commands) {
  const dmp = cmd.data.toJSON().default_member_permissions;
  if (name === 'setup' || name === 'config') {
    if (dmp !== '0') { console.error('FAIL:', name, 'sollte default_member_permissions=\"0\" haben, hat:', dmp); ok = false; }
    else console.log(name, '→ default_member_permissions:', dmp, '(korrekt, owner-only)');
    continue;
  }
  if (dmp !== null && dmp !== undefined) { console.error('FAIL:', name, 'hat noch default_member_permissions:', dmp); ok = false; }
  else console.log(name, '→ keine default_member_permissions (korrekt)');
}
process.exit(ok ? 0 : 1);
"
```

Expected: `/setup` und `/config` zeigen `default_member_permissions: 0`. Alle anderen zeigen null/undefined. Exit-Code 0.

- [ ] **Step 3: Bot startet komplett ohne Crash + deployt Commands**

Mit Docker MySQL laufend:

Run:
```bash
timeout 15 node --env-file=.env index.js || true
```

Expected: Logs zeigen `MySQL reachable.` → `Schema sichergestellt.` → `Slash-Befehle deployed.` (oder ähnlich aus deployCommands.js) → `Logged in as Oreo#... (14 command(s) loaded)`. **14 Commands** = die 11 alten + `/setup` + `/config` + (Stage-1.5-Commands wenn Stage 1.5 bereits gemerged ist, was Voraussetzung war).

---

## Task 9: Manuelle E2E-Verifikation in Discord

**Files:** keine

Stage 2a ist deployed → folgende Tests in Discord ausführen.

**Vorbereitung:** `node src/deployCommands.js` einmal manuell laufen lassen, sodass `/setup` und `/config` in Discord registriert sind. Sicherstellen, dass `role_permissions` initial leer ist für die Test-Guild (`DELETE FROM role_permissions WHERE guild_id = <test_guild>`).

- [ ] **Test 1: Frisches Deployment, Owner ruft `/setup admin-role:@Admins`**

Erwartung: DB hat 1 Zeile (`admin`), Reply zeigt Embed mit `Admin: @Admins`, `Mod: (nicht gesetzt)`, `Helper: (nicht gesetzt)`.

- [ ] **Test 2: Nicht-Owner ruft `/setup admin-role:@Admins`**

Erwartung: Ephemeral *"Nur der Server-Inhaber kann /setup ausführen."*. DB unverändert.

- [ ] **Test 3: Owner ruft `/setup admin-role:@A mod-role:@A`** (doppelte Rolle)

Erwartung: Ephemeral *"Eine Rolle kann nicht mehreren Tiers zugewiesen werden."*. DB unverändert (kein DELETE).

- [ ] **Test 4: User mit @Admins ruft `/ban`** (auf Test-User)

Erwartung: Ban läuft durch. Discord-side Bot-Capability (`.bannable`) muss erfüllt sein.

- [ ] **Test 5: User nur mit @Moderatoren ruft `/ban`**

Erwartung: Ephemeral *"Du brauchst Tier 'admin' oder höher für diesen Befehl."*.

- [ ] **Test 6: User mit @Moderatoren ruft `/warn`**

Erwartung: Warn läuft durch.

- [ ] **Test 7: User mit @Helper ruft `/case 1`**

Erwartung: Embed wird angezeigt.

- [ ] **Test 8: User mit @Helper ruft `/warn`**

Erwartung: Ephemeral *"Du brauchst Tier 'mod' oder höher für diesen Befehl."*.

- [ ] **Test 9: User ohne zugewiesene Rolle ruft `/ping`**

Erwartung: Ephemeral *"Du brauchst Tier 'helper' oder höher für diesen Befehl."*.

- [ ] **Test 10: Admin ruft `/config role set role:@Helper2 tier:helper`**

Erwartung: Reply *"Rolle @Helper2 hat jetzt Tier 'helper'."*.

- [ ] **Test 11: Admin ruft `/config role set role:@Helper2 tier:mod`** (bereits gesetzt)

Erwartung: Reply *"Rolle @Helper2 wurde von Tier 'helper' auf 'mod' geändert."*. Erneuter Aufruf mit selbem Tier → *"war bereits Tier 'mod'."*.

- [ ] **Test 12: Admin ruft `/config role unset` für eigene letzte Admin-Rolle** (User ist NICHT Owner)

Erwartung: Ephemeral Lockout-Warnung. DB-Verifikation: admin-Rolle ist noch da.

- [ ] **Test 13: Owner ruft `/config role unset` für eigene letzte Admin-Rolle**

Erwartung: DELETE läuft durch, Reply *"Rolle @X hat keinen Tier mehr (entfernt)."*. Owner ist jetzt Tier-los, kann aber jederzeit `/setup` aufrufen.

- [ ] **Test 14: `/config role list` mit gelöschter Discord-Rolle in DB**

Vorbereitung: Test-Rolle auf Discord löschen, die noch in `role_permissions` steht.

Erwartung: Embed zeigt den Eintrag mit `⚠️ (gelöscht)`-Badge.

- [ ] **Test 15: Owner ruft `/setup` zweimal mit verschiedenen Rollen**

Erwartung: Erste Zuweisungen sind im 2. Setup gelöscht (DELETE FROM ... WHERE guild_id), nur die neuen stehen.

- [ ] **Step Final: Commit-Message für Manual-Test-Pass**

```bash
git commit --allow-empty -m "chore: stage 2a manual e2e tests passed (15 scenarios per spec)"
```

---

## Roll-out (nach Plan-Fertigstellung)

1. **PR auf `main` öffnen** für `feat/role-permissions-stage2a`.
2. **PR mergen** in `main`.
3. **Auf Produktion (Server):**
   ```bash
   git pull origin main
   docker compose up -d --build
   ```
4. **`node src/deployCommands.js` einmal manuell** ausführen — Slash-Schemas haben sich geändert.
5. **Server-Owner führt sofort `/setup admin-role:@…` aus** — sonst sind ALLE Commands für ALLE gesperrt.
6. Pre-Deploy-Warnung an Server-Owner: *"Nach Update sofort /setup. Bis dahin können Mods nichts. Owner kann immer recovern."*

**Rollback:** Vorherigen Container-Tag re-deployen + alten `deployCommands.js` laufen lassen. `role_permissions`-Tabelle bleibt — Stage-1.5-Code ignoriert sie.
