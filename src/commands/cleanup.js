const { SlashCommandBuilder, MessageFlags, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cleanup')
    .setDescription('Löscht die letzten N Messages (optional gefiltert).')
    .addIntegerOption((o) => o.setName('amount').setDescription('Anzahl Messages (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
    .addUserOption((o) => o.setName('user').setDescription('Nur Messages von diesem User').setRequired(false))
    .addStringOption((o) => o.setName('contains').setDescription('Nur Messages die diesen Text enthalten').setRequired(false))
    .addBooleanOption((o) => o.setName('bots_only').setDescription('Nur Bot-Messages').setRequired(false)),

  requiredTier: 'moderator',

  async execute(interaction) {
    const channel = interaction.channel;

    // Channel-type guard
    if (!channel?.isTextBased() || channel.isDMBased()) {
      return interaction.reply({ content: '❌ Nur Text-Channels.', flags: MessageFlags.Ephemeral });
    }

    // Bot-permission guard
    const botPerms = channel.permissionsFor(interaction.guild.members.me);
    if (!botPerms?.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({
        content: `❌ Mir fehlt die Permission \`ManageMessages\` in <#${channel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const amount = interaction.options.getInteger('amount');
    const userFilter = interaction.options.getUser('user');
    const containsFilter = interaction.options.getString('contains');
    const botsOnly = interaction.options.getBoolean('bots_only') ?? false;

    let fetched;
    try {
      fetched = await channel.messages.fetch({ limit: amount });
    } catch (err) {
      console.warn('/cleanup fetch failed:', err);
      return interaction.reply({
        content: `❌ Messages konnten nicht abgerufen werden: ${err.code ?? err.message ?? 'unbekannt'}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const filtered = [...fetched.values()].filter((m) => {
      if (userFilter && m.author.id !== userFilter.id) return false;
      if (containsFilter && !m.content?.toLowerCase().includes(containsFilter.toLowerCase())) return false;
      if (botsOnly && !m.author.bot) return false;
      return true;
    });

    if (filtered.length === 0) {
      return interaction.reply({
        content: `⚠️ Keine Messages matchen den Filter (von ${fetched.size} geprüften).`,
        flags: MessageFlags.Ephemeral,
      });
    }

    let deleted;
    try {
      const deletedCollection = await channel.bulkDelete(filtered, true);
      deleted = deletedCollection.size;
    } catch (err) {
      console.warn('/cleanup bulkDelete failed:', err);
      return interaction.reply({
        content: `❌ Aktion fehlgeschlagen: ${err.code ?? err.message ?? 'unbekannter Fehler'}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const skipped = filtered.length - deleted;
    const replyMessage = skipped > 0
      ? `✅ ${deleted} Messages gelöscht. (${skipped} waren älter als 14 Tage und wurden übersprungen)`
      : `✅ ${deleted} Messages gelöscht.`;
    await interaction.reply({ content: replyMessage, flags: MessageFlags.Ephemeral });

    // Mod-Log-Embed (fail-soft, inline)
    try {
      const modLogChannelId = await config.getModLogChannelId(interaction.guildId);
      if (modLogChannelId) {
        const modLogChannel = await interaction.client.channels.fetch(modLogChannelId);
        if (modLogChannel) {
          const filterParts = [];
          if (userFilter) filterParts.push(`user=<@${userFilter.id}>`);
          if (containsFilter) filterParts.push(`contains="${containsFilter}"`);
          if (botsOnly) filterParts.push('bots_only');

          const embed = new EmbedBuilder()
            .setTitle('🧹 Cleanup')
            .setColor(0x5865f2)
            .addFields(
              { name: '🛡️ Moderator', value: `<@${interaction.user.id}>`, inline: true },
              { name: '📺 Channel', value: `<#${channel.id}>`, inline: true },
              { name: '🗑️ Gelöscht', value: `${deleted} Messages`, inline: false },
            );
          if (filterParts.length > 0) {
            embed.addFields({ name: '🔍 Filter', value: filterParts.join(', '), inline: false });
          }
          embed.setFooter({ text: '🐾 Oreo' }).setTimestamp();
          await modLogChannel.send({ embeds: [embed] });
        }
      }
    } catch (err) {
      console.warn('[cleanup] modlog post failed:', err);
    }
  },
};
