const { SlashCommandBuilder, MessageFlags, EmbedBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { getPool } = require('../db');
const escalations = require('../escalations');
const { parseDuration, formatDuration, MAX_TIMEOUT_MS } = require('../duration');

const TIER_CHOICES = [
  { name: 'supporter', value: 'supporter' },
  { name: 'moderator', value: 'moderator' },
  { name: 'owner',     value: 'owner'     },
];

const TIER_ORDER = ['owner', 'moderator', 'supporter'];

const CHANNEL_TYPE_CHOICES = [
  { name: 'report', value: 'report' },
  { name: 'modlog', value: 'modlog' },
];

// type → DB-Spalte
const CHANNEL_COLUMN = {
  report: 'report_channel_id',
  modlog: 'mod_log_channel_id',
};

// type → User-facing Label
const CHANNEL_LABEL = {
  report: 'report',
  modlog: 'modlog',
};

const FEATURE_CHOICES = [
  { name: 'automod', value: 'automod' },
];

// feature → DB-Spalte
const FEATURE_COLUMN = {
  automod: 'automod_enabled',
};

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
    )
    .addSubcommandGroup((group) =>
      group.setName('channel').setDescription('Channel-Konfiguration (report, modlog)')
        .addSubcommand((sub) =>
          sub.setName('set').setDescription('Setzt einen Channel.')
            .addStringOption((o) => o.setName('type').setDescription('Welcher Channel').setRequired(true).addChoices(...CHANNEL_TYPE_CHOICES))
            .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
        )
        .addSubcommand((sub) =>
          sub.setName('unset').setDescription('Entfernt einen Channel.')
            .addStringOption((o) => o.setName('type').setDescription('Welcher Channel').setRequired(true).addChoices(...CHANNEL_TYPE_CHOICES))
        )
        .addSubcommand((sub) =>
          sub.setName('list').setDescription('Zeigt beide Channels.')
        )
    )
    .addSubcommandGroup((group) =>
      group.setName('feature').setDescription('Feature-Toggles')
        .addSubcommand((sub) =>
          sub.setName('set').setDescription('Schaltet ein Feature ein oder aus.')
            .addStringOption((o) => o.setName('name').setDescription('Feature-Name').setRequired(true).addChoices(...FEATURE_CHOICES))
            .addBooleanOption((o) => o.setName('value').setDescription('true = aktivieren, false = deaktivieren').setRequired(true))
        )
    )
    .addSubcommandGroup((group) =>
      group.setName('escalation').setDescription('Auto-Eskalations-Regeln')
        .addSubcommand((sub) =>
          sub.setName('set').setDescription('Setzt oder aktualisiert eine Eskalations-Regel.')
            .addIntegerOption((o) => o.setName('warn_threshold').setDescription('Aktive Warn-Anzahl bei der die Regel feuert (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
            .addStringOption((o) => o.setName('action').setDescription('Action').setRequired(true).addChoices(
              { name: 'timeout', value: 'timeout' },
              { name: 'kick', value: 'kick' },
              { name: 'ban', value: 'ban' },
            ))
            .addStringOption((o) => o.setName('duration').setDescription('Dauer (nur bei timeout) — z.B. 30m, 2h, 7d').setRequired(false))
        )
        .addSubcommand((sub) =>
          sub.setName('unset').setDescription('Entfernt eine Eskalations-Regel.')
            .addIntegerOption((o) => o.setName('warn_threshold').setDescription('Aktive Warn-Anzahl der zu entfernenden Regel (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
        )
        .addSubcommand((sub) =>
          sub.setName('list').setDescription('Zeigt alle konfigurierten Eskalations-Regeln.')
        )
    )
    .addSubcommand((sub) =>
      sub.setName('show').setDescription('Zeigt die komplette Server-Konfiguration.')
    ),

  requiredTier: 'owner',

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (group === 'role') {
      if (sub === 'set')   return handleRoleSet(interaction);
      if (sub === 'unset') return handleRoleUnset(interaction);
      if (sub === 'list')  return handleRoleList(interaction);
    }

    if (group === 'channel') {
      if (sub === 'set')   return handleChannelSet(interaction);
      if (sub === 'unset') return handleChannelUnset(interaction);
      if (sub === 'list')  return handleChannelList(interaction);
    }

    if (group === 'feature') {
      if (sub === 'set') return handleFeatureSet(interaction);
    }

    if (group === 'escalation') {
      if (sub === 'set')   return handleEscalationSet(interaction);
      if (sub === 'unset') return handleEscalationUnset(interaction);
      if (sub === 'list')  return handleEscalationList(interaction);
    }

    if (group === null && sub === 'show') {
      return handleShow(interaction);
    }

    return interaction.reply({
      content: 'Unbekannter Subcommand.',
      flags: MessageFlags.Ephemeral,
    });
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
    // TOCTOU: previousTier is advisory — a concurrent /config role set on the
    // same role may make the user-facing message inaccurate ("was already X"
    // / "changed from X to Y"). Final DB state is always correct (last write
    // wins via ON DUPLICATE KEY UPDATE). Same pattern as /reason.
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
      await conn.rollback().catch(() => {});
      return interaction.reply({
        content: `Rolle <@&${role.id}> hatte keinen Tier — nichts zu tun.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Lockout-Schutz: wenn keine owner-Tier-Rolle mehr UND User ist nicht Discord-Server-
    // Owner → Rollback. FOR UPDATE versucht die noch lebenden owner-Rows zu locken. Wenn
    // nach dem DELETE keine owner-Rows mehr matchen, lockt FOR UPDATE NICHTS — zwei
    // parallele Transaktionen sehen beide ownerCount=0 und rollen beide zurück. Korrekt
    // by design (rollback ist der sichere Pfad), nicht durch den Lock erzwungen.
    // Hinweis: 'owner'-Tier (DB) ≠ Discord-Server-Owner (interaction.guild.ownerId).
    const [ownerRows] = await conn.execute(
      'SELECT COUNT(*) AS n FROM role_permissions WHERE guild_id = ? AND permission = ? FOR UPDATE',
      [interaction.guildId, 'owner'],
    );
    const ownerCount = Number(ownerRows[0].n);
    const isServerOwner = interaction.user.id === interaction.guild.ownerId;

    if (ownerCount === 0 && !isServerOwner) {
      await conn.rollback().catch(() => {});
      return interaction.reply({
        content: "Abbruch — das wäre die letzte Owner-Tier-Rolle. Setze erst eine andere Rolle auf 'owner' oder lass den Discord-Server-Owner das machen.",
        flags: MessageFlags.Ephemeral,
      });
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
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

  const byTier = { owner: [], moderator: [], supporter: [] };
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


const MAX_ROLES_IN_PERM_WARNING = 10;

/**
 * Sammelt moderator+ Rollen, die das angegebene Channel nicht sehen können.
 * Liefert leeres Array bei keinen Blockern oder DB/Discord-Fehler (fail-soft).
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildChannel} channel
 * @returns {Promise<string[]>} Array von Role-IDs (string)
 */
async function collectReportPermWarnings(guild, channel) {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT role_id FROM role_permissions
       WHERE guild_id = ? AND permission IN ('moderator', 'owner')`,
    [guild.id],
  );

  const blocked = [];
  for (const { role_id } of rows) {
    const roleIdStr = String(role_id);
    const role = guild.roles.cache.get(roleIdStr)
      ?? await guild.roles.fetch(roleIdStr).catch(() => null);
    if (!role) continue; // Rolle gelöscht → silent skip
    const perms = channel.permissionsFor(role);
    if (!perms || !perms.has(PermissionFlagsBits.ViewChannel)) {
      blocked.push(role.id);
    }
  }
  return blocked;
}

async function handleChannelSet(interaction) {
  const type = interaction.options.getString('type');
  const channel = interaction.options.getChannel('channel');

  if (channel.type !== ChannelType.GuildText) {
    return interaction.reply({
      content: 'Nur Text-Channels werden unterstützt.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Permission-Check für Bot
  const botMember = interaction.guild.members.me;
  const botPerms = channel.permissionsFor(botMember);
  if (!botPerms) {
    return interaction.reply({
      content: `Ich kann die Permissions in <#${channel.id}> nicht auslesen. Stehe ich noch auf dem Server?`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!botPerms.has(PermissionFlagsBits.SendMessages)) {
    return interaction.reply({
      content: `Mir fehlt die Permission 'Nachrichten senden' in <#${channel.id}>. Bitte zuerst beheben.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!botPerms.has(PermissionFlagsBits.EmbedLinks)) {
    return interaction.reply({
      content: `Mir fehlt die Permission 'Embed-Links' in <#${channel.id}>. Bitte zuerst beheben.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // Stage 2d: Report-Channel Permission-Check (Spec §5)
  let permissionWarnings = [];
  if (type === 'report') {
    try {
      permissionWarnings = await collectReportPermWarnings(interaction.guild, channel);
    } catch (err) {
      console.warn('collectReportPermWarnings failed:', err);
      // fail-soft: kein Warning, Channel-Set läuft weiter
    }
  }

  const column = CHANNEL_COLUMN[type];
  const label = CHANNEL_LABEL[type];
  const pool = getPool();
  let previousId = null;

  try {
    await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [interaction.guildId]);
    const [existing] = await pool.execute(
      `SELECT ${column} AS value FROM guilds WHERE guild_id = ?`,
      [interaction.guildId],
    );
    previousId = existing[0]?.value ? String(existing[0].value) : null;

    await pool.execute(
      `UPDATE guilds SET ${column} = ? WHERE guild_id = ?`,
      [channel.id, interaction.guildId],
    );
  } catch (err) {
    console.error('/config channel set DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  let message;
  if (previousId === channel.id) {
    message = `Channel \`${label}\` war bereits <#${channel.id}>.`;
  } else if (previousId) {
    message = `Channel \`${label}\` von <#${previousId}> auf <#${channel.id}> geändert.`;
  } else {
    message = `Channel \`${label}\` gesetzt auf <#${channel.id}>.`;
  }

  if (permissionWarnings.length > 0) {
    const shown = permissionWarnings.slice(0, MAX_ROLES_IN_PERM_WARNING).map(id => `<@&${id}>`).join(', ');
    const overflow = permissionWarnings.length - MAX_ROLES_IN_PERM_WARNING;
    const rolesList = overflow > 0 ? `${shown}, +${overflow} weitere` : shown;
    message += `\n\n⚠️ Achtung: Folgende Mod-Rollen können den Channel nicht sehen: ${rolesList}\nBitte \`View Channel\`-Permission setzen, sonst sehen sie keine eingehenden Reports.`;
  }

  return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}

async function handleChannelUnset(interaction) {
  const type = interaction.options.getString('type');
  const column = CHANNEL_COLUMN[type];
  const label = CHANNEL_LABEL[type];
  const pool = getPool();
  let previousId = null;

  try {
    const [existing] = await pool.execute(
      `SELECT ${column} AS value FROM guilds WHERE guild_id = ?`,
      [interaction.guildId],
    );
    previousId = existing[0]?.value ? String(existing[0].value) : null;

    if (previousId === null) {
      return interaction.reply({
        content: `Channel \`${label}\` war nicht konfiguriert — nichts zu tun.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    await pool.execute(
      `UPDATE guilds SET ${column} = NULL WHERE guild_id = ?`,
      [interaction.guildId],
    );
  } catch (err) {
    console.error('/config channel unset DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: `Channel \`${label}\` entfernt (war <#${previousId}>).`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleChannelList(interaction) {
  let row;
  try {
    const [rows] = await getPool().execute(
      'SELECT mod_log_channel_id, report_channel_id FROM guilds WHERE guild_id = ?',
      [interaction.guildId],
    );
    row = rows[0] ?? null;
  } catch (err) {
    console.error('/config channel list DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const reportId = row?.report_channel_id ? String(row.report_channel_id) : null;
  const modlogDbId = row?.mod_log_channel_id ? String(row.mod_log_channel_id) : null;
  const modlogEnvId = !modlogDbId && process.env.MODLOG_CHANNEL_ID ? process.env.MODLOG_CHANNEL_ID : null;

  const reportLine = reportId ? `<#${reportId}>` : '(nicht konfiguriert)';
  let modlogLine;
  if (modlogDbId) modlogLine = `<#${modlogDbId}>`;
  else if (modlogEnvId) modlogLine = `<#${modlogEnvId}> *(env-Fallback)*`;
  else modlogLine = '(nicht konfiguriert)';

  const embed = new EmbedBuilder()
    .setTitle('🔧 Channel-Konfiguration')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Report-Channel',  value: reportLine, inline: false },
      { name: 'Mod-Log-Channel', value: modlogLine, inline: false },
    )
    .setFooter({ text: '🐾 Oreo' });

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleFeatureSet(interaction) {
  const name = interaction.options.getString('name');
  const value = interaction.options.getBoolean('value');
  const column = FEATURE_COLUMN[name];

  const pool = getPool();
  try {
    await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [interaction.guildId]);
    await pool.execute(
      `UPDATE guilds SET ${column} = ? WHERE guild_id = ?`,
      [value ? 1 : 0, interaction.guildId],
    );
  } catch (err) {
    console.error('/config feature set DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  let message;
  if (name === 'automod' && value) {
    message = `Feature \`automod\` aktiviert.\n⚠️ Automod-Logik ist erst ab Stage 4 implementiert. Toggle ist heute ein Stub.`;
  } else {
    message = `Feature \`${name}\` ${value ? 'aktiviert' : 'deaktiviert'}.`;
  }

  return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}

const ACTION_ICON = { timeout: '⏱️', kick: '👢', ban: '🔨' };
const MAX_ESCALATION_RULES_IN_SHOW = 5;

async function handleEscalationSet(interaction) {
  const threshold = interaction.options.getInteger('warn_threshold');
  const action = interaction.options.getString('action');
  const durationInput = interaction.options.getString('duration');

  let durationMinutes = null;
  let durationDisplay = null;
  let ignoredDurationWarning = false;

  if (action === 'timeout') {
    if (!durationInput) {
      return interaction.reply({
        content: '❌ Dauer ist für `action:timeout` erforderlich. Beispiel: `30m`, `2h`, `7d`.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const durationMs = parseDuration(durationInput);
    if (durationMs == null) {
      return interaction.reply({
        content: '❌ Ungültige Dauer-Angabe.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (durationMs < 60_000) {
      return interaction.reply({
        content: '❌ Min. Timeout-Dauer ist 1 Minute.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (durationMs > MAX_TIMEOUT_MS) {
      return interaction.reply({
        content: '❌ Maximale Timeout-Dauer ist 28 Tage.',
        flags: MessageFlags.Ephemeral,
      });
    }
    durationMinutes = Math.floor(durationMs / 60_000);
    durationDisplay = formatDuration(durationMs);
  } else if (durationInput) {
    ignoredDurationWarning = true;
  }

  try {
    await escalations.setRule(interaction.guildId, threshold, action, durationMinutes);
  } catch (err) {
    console.error('/config escalation set DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const icon = ACTION_ICON[action] ?? '';
  const actionLabel = durationDisplay ? `${icon} ${capitalize(action)} ${durationDisplay}` : `${icon} ${capitalize(action)}`;
  let message = `✅ Eskalation gesetzt: bei ${threshold} aktiven Warns → ${actionLabel}`;
  if (ignoredDurationWarning) {
    message += `\n⚠️ Dauer wird bei \`${action}\` ignoriert.`;
  }
  return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}

async function handleEscalationUnset(interaction) {
  const threshold = interaction.options.getInteger('warn_threshold');
  let affected = 0;
  try {
    affected = await escalations.removeRule(interaction.guildId, threshold);
  } catch (err) {
    console.error('/config escalation unset DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const message = affected > 0
    ? `✅ Eskalation für Schwelle ${threshold} entfernt.`
    : `Keine Eskalation für Schwelle ${threshold} konfiguriert — nichts zu tun.`;
  return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}

async function handleEscalationList(interaction) {
  let rules = [];
  try {
    rules = await escalations.listRules(interaction.guildId);
  } catch (err) {
    console.error('/config escalation list DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('🎯 Eskalations-Regeln')
    .setColor(0x5865f2)
    .setFooter({ text: '🐾 Oreo' })
    .setTimestamp();

  if (rules.length === 0) {
    embed.setDescription('Keine Eskalations-Regeln konfiguriert. Setze welche mit `/config escalation set`.');
  } else {
    embed.setDescription(rules.map(formatRuleLine).join('\n'));
  }

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

function formatRuleLine(rule) {
  const icon = ACTION_ICON[rule.action] ?? '';
  const threshold = Number(rule.warn_threshold);
  if (rule.action === 'timeout' && rule.duration_minutes) {
    const durMs = Number(rule.duration_minutes) * 60_000;
    return `• Schwelle ${threshold} → ${icon} Timeout ${formatDuration(durMs)}`;
  }
  return `• Schwelle ${threshold} → ${icon} ${capitalize(rule.action)}`;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function handleShow(interaction) {
  let guildRow;
  let roleRows;
  try {
    const pool = getPool();
    const [gRows] = await pool.execute(
      'SELECT mod_log_channel_id, report_channel_id, automod_enabled, next_case_number FROM guilds WHERE guild_id = ?',
      [interaction.guildId],
    );
    guildRow = gRows[0] ?? null;
    const [rRows] = await pool.execute(
      'SELECT role_id, permission FROM role_permissions WHERE guild_id = ?',
      [interaction.guildId],
    );
    roleRows = rRows;
  } catch (err) {
    console.error('/config show DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Channels
  const reportId = guildRow?.report_channel_id ? String(guildRow.report_channel_id) : null;
  const modlogDbId = guildRow?.mod_log_channel_id ? String(guildRow.mod_log_channel_id) : null;
  const modlogEnvId = !modlogDbId && process.env.MODLOG_CHANNEL_ID ? process.env.MODLOG_CHANNEL_ID : null;

  const reportLine = reportId ? `<#${reportId}>` : '(nicht konfiguriert)';
  let modlogLine;
  if (modlogDbId) modlogLine = `<#${modlogDbId}>`;
  else if (modlogEnvId) modlogLine = `<#${modlogEnvId}> *(env-Fallback)*`;
  else modlogLine = '(nicht konfiguriert)';

  // Features
  const automodOn = Boolean(guildRow?.automod_enabled);
  const automodLine = automodOn ? '✅ aktiv' : '❌ deaktiviert';

  // Stats — next_case_number stores the LAST assigned (atomic LAST_INSERT_ID pattern in cases.js).
  // Next-to-assign = stored + 1. If no row exists yet, the first case will be #1.
  const nextCase = `#${guildRow ? Number(guildRow.next_case_number) + 1 : 1}`;

  // Roles (nach Tier gruppiert)
  const byTier = { owner: [], moderator: [], supporter: [] };
  for (const r of roleRows) {
    const rid = String(r.role_id);
    const stillExists = interaction.guild.roles.cache.has(rid);
    const display = stillExists ? `<@&${rid}>` : `<@&${rid}> ⚠️`;
    byTier[r.permission]?.push(display);
  }
  const roleLines = TIER_ORDER
    .map((t) => `**${t.toUpperCase()}**: ${byTier[t].length > 0 ? byTier[t].join(', ') : '—'}`)
    .join('\n');
  const rolesValue = roleRows.length > 0 ? roleLines : '(keine Rollen konfiguriert)';

  // Stage 3: Eskalations-Regeln für show
  let escalationRules = [];
  try {
    escalationRules = await escalations.listRules(interaction.guildId);
  } catch (err) {
    console.warn('handleShow: listRules failed', err);
  }

  let escalationValue;
  if (escalationRules.length === 0) {
    escalationValue = 'keine Regeln gesetzt';
  } else {
    const shown = escalationRules.slice(0, MAX_ESCALATION_RULES_IN_SHOW).map(formatRuleLine);
    const overflow = escalationRules.length - MAX_ESCALATION_RULES_IN_SHOW;
    if (overflow > 0) shown.push(`... +${overflow} weitere`);
    escalationValue = shown.join('\n');
  }

  const embed = new EmbedBuilder()
    .setTitle('🛡️ Server-Konfiguration')
    .setColor(0x5865f2)
    .addFields(
      { name: '📺 Channels',     value: `Report: ${reportLine}\nMod-Log: ${modlogLine}`, inline: false },
      { name: '⚙️ Features',     value: `Automod: ${automodLine}`,                       inline: false },
      { name: '🎯 Eskalation',   value: escalationValue,                                  inline: false },
      { name: '📊 Statistiken',  value: `Nächste Case-Nr: ${nextCase}`,                  inline: false },
      { name: '🔐 Rollen-Tiers', value: rolesValue,                                       inline: false },
    )
    .setFooter({ text: '🐾 Oreo' });

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
