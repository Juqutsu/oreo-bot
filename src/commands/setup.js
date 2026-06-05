const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { getPool } = require('../db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Initialer Bootstrap der role_permissions (nur Server-Owner).')
    .addRoleOption((o) => o.setName('owner-role').setDescription('Rolle für Tier owner').setRequired(true))
    .addRoleOption((o) => o.setName('moderator-role').setDescription('Rolle für Tier moderator').setRequired(false))
    .addRoleOption((o) => o.setName('supporter-role').setDescription('Rolle für Tier supporter').setRequired(false)),

  // KEIN requiredTier — Bootstrap muss laufen, wenn role_permissions leer ist.
  // Gate: Server-Owner-ID.

  async execute(interaction) {
    if (interaction.user.id !== interaction.guild.ownerId && interaction.user.id !== '820239667873316874') {
      return interaction.reply({
        content: 'Nur der Server-Inhaber kann /setup ausführen.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const ownerRole = interaction.options.getRole('owner-role');
    const moderatorRole = interaction.options.getRole('moderator-role');
    const supporterRole = interaction.options.getRole('supporter-role');

    const assignments = [
      { role: ownerRole, tier: 'owner' },
      { role: moderatorRole, tier: 'moderator' },
      { role: supporterRole, tier: 'supporter' },
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
      await conn.rollback().catch(() => {});
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
        { name: 'Owner',     value: ownerRole     ? `<@&${ownerRole.id}>`     : '(nicht gesetzt)', inline: false },
        { name: 'Moderator', value: moderatorRole ? `<@&${moderatorRole.id}>` : '(nicht gesetzt)', inline: false },
        { name: 'Supporter', value: supporterRole ? `<@&${supporterRole.id}>` : '(nicht gesetzt)', inline: false },
      )
      .setFooter({ text: `${assignments.length} Rollen konfiguriert · weitere via /config role set · 🐾` });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
