const {
  SlashCommandBuilder,
  MessageFlags,
  PermissionFlagsBits,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('announcement')
    .setDescription('Postet eine offizielle Announcement (Embed) im gewählten Channel.')
    .addChannelOption((o) =>
      o.setName('channel')
        .setDescription('Ziel-Channel (default: current)')
        .setRequired(false)
        .addChannelTypes(ChannelType.GuildText)
    )
    .addRoleOption((o) =>
      o.setName('ping')
        .setDescription('Optional: Rolle die geping\'t werden soll (inkl. @everyone)')
        .setRequired(false)
    ),

  requiredTier: 'moderator',

  async execute(interaction) {
    const targetChannel = interaction.options.getChannel('channel') ?? interaction.channel;

    if (!targetChannel?.isTextBased() || targetChannel.isDMBased()) {
      return interaction.reply({ content: '❌ Nur Text-Channels.', flags: MessageFlags.Ephemeral });
    }

    const botPerms = targetChannel.permissionsFor(interaction.guild.members.me);
    if (!botPerms?.has(PermissionFlagsBits.SendMessages)) {
      return interaction.reply({
        content: `❌ Mir fehlt die Permission \`SendMessages\` in <#${targetChannel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!botPerms.has(PermissionFlagsBits.EmbedLinks)) {
      return interaction.reply({
        content: `❌ Mir fehlt die Permission \`EmbedLinks\` in <#${targetChannel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const pingRole = interaction.options.getRole('ping');
    const pingRoleId = pingRole?.id ?? 'none';

    if (pingRole && pingRole.id === interaction.guild.id) {
      if (!botPerms.has(PermissionFlagsBits.MentionEveryone)) {
        return interaction.reply({
          content: `❌ Mir fehlt die Permission \`MentionEveryone\` in <#${targetChannel.id}>.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    const modal = new ModalBuilder()
      .setCustomId(`announcement:modal:${targetChannel.id}:${pingRoleId}`)
      .setTitle('Announcement erstellen');

    const titleInput = new TextInputBuilder()
      .setCustomId('title')
      .setLabel('Title')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(256);

    const descInput = new TextInputBuilder()
      .setCustomId('description')
      .setLabel('Description')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(4000);

    modal.addComponents(
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(descInput),
    );

    await interaction.showModal(modal);
  },
};
