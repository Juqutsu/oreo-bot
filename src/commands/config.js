const { SlashCommandBuilder, MessageFlags, EmbedBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { getPool } = require('../db');

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
