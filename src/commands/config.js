const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { getPool } = require('../db');

const TIER_CHOICES = [
  { name: 'supporter', value: 'supporter' },
  { name: 'moderator', value: 'moderator' },
  { name: 'owner',     value: 'owner'     },
];

const TIER_ORDER = ['owner', 'moderator', 'supporter'];

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

  requiredTier: 'owner',

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
