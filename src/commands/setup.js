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
