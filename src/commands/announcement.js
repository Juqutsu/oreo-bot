const {
  SlashCommandBuilder,
  MessageFlags,
  PermissionFlagsBits,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const announcements = require('../announcements');

// Farb-Choices für /announcement create farbe. Keys sind die Choice-Values und landen
// unverändert im Modal-CustomId (announcement:modal:create:...:<colorKey>) — Task 3
// liest den Key hier raus, um die Embed-Farbe zu setzen.
const COLORS = {
  blurple: 0x5865f2,
  gruen: 0x57f287,
  rot: 0xed4245,
  gelb: 0xfee75c,
  orange: 0xe67e22,
  lila: 0x9b59b6,
};

const COLOR_CHOICES = [
  { name: 'Blurple', value: 'blurple' },
  { name: 'Grün', value: 'gruen' },
  { name: 'Rot', value: 'rot' },
  { name: 'Gelb', value: 'gelb' },
  { name: 'Orange', value: 'orange' },
  { name: 'Lila', value: 'lila' },
];

// Discord-Choice-Namen sind auf 100 Zeichen begrenzt — Titel defensiv auf 60 kürzen.
function truncate(str, max) {
  if (!str) return str;
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

// Formatiert ein Datum als "TT.MM." für die Autocomplete-Anzeige.
function formatDayMonth(dateLike) {
  const d = new Date(dateLike);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.`;
}

// Formats a date as "TT.MM.JJJJ" for the /announcement list overview.
function formatFullDate(dateLike) {
  const d = new Date(dateLike);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

/**
 * Small, self-contained embed for the delete-confirmation prompt (preview of the original
 * announcement from the DB row). Deliberately NOT importing the same-named
 * buildAnnouncementEmbed from src/interactions/announcement.js: that module already
 * requires this one (COLORS, buildAnnouncementModal), so importing back would be a require
 * cycle. This copy is intentionally minimal (confirmation preview only) rather than sharing
 * the builder across the cycle.
 */
function buildDeletePreviewEmbed(row) {
  const embed = new EmbedBuilder()
    .setTitle(row.title)
    .setDescription(row.description)
    .setColor(row.color ?? COLORS.blurple)
    .setFooter({ text: row.edited_at ? '🐾 Oreo • bearbeitet' : '🐾 Oreo' })
    .setTimestamp(row.created_at);

  if (row.image_url) embed.setImage(row.image_url);

  return embed;
}

/**
 * Baut das Announcement-Modal deklarativ — für create (leere Defaults) und edit
 * (vorbefüllt aus der DB-Row) gleichermaßen.
 *
 * WICHTIG: TextInputBuilder#setValue() wird von discord.js gegen die Length-Constraints
 * des Inputs validiert. Für leere Prefill-Werte (create-Fall) daher bewusst NICHT
 * aufrufen — nur bei nicht-leeren Werten vorbefüllen.
 */
function buildAnnouncementModal({ customId, title = '', description = '', imageUrl = '' }) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle('Announcement');

  const titleInput = new TextInputBuilder()
    .setCustomId('title')
    .setLabel('Title')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(256);
  if (title) titleInput.setValue(title);

  const descriptionInput = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('Description')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000);
  if (description) descriptionInput.setValue(description);

  const imageUrlInput = new TextInputBuilder()
    .setCustomId('image_url')
    .setLabel('Image URL (optional)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(512);
  if (imageUrl) imageUrlInput.setValue(imageUrl);

  modal.addComponents(
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(descriptionInput),
    new ActionRowBuilder().addComponents(imageUrlInput),
  );

  return modal;
}

async function executeCreate(interaction) {
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

  const colorKey = interaction.options.getString('farbe') ?? 'blurple';

  await interaction.showModal(
    buildAnnouncementModal({
      customId: `announcement:modal:create:${targetChannel.id}:${pingRoleId}:${colorKey}`,
    }),
  );
}

async function executeEdit(interaction) {
  const id = Number.parseInt(interaction.options.getString('id'), 10);

  if (id === 0 || Number.isNaN(id)) {
    return interaction.reply({ content: '❌ Keine Announcements vorhanden.', flags: MessageFlags.Ephemeral });
  }

  const row = await announcements.getAnnouncement(interaction.guildId, id);
  if (!row) {
    return interaction.reply({ content: `❌ Announcement #${id} nicht gefunden.`, flags: MessageFlags.Ephemeral });
  }
  if (row.status === 'deleted') {
    return interaction.reply({ content: '❌ Dieses Announcement wurde bereits gelöscht.', flags: MessageFlags.Ephemeral });
  }

  await interaction.showModal(
    buildAnnouncementModal({
      customId: `announcement:modal:edit:${row.id}`,
      title: row.title,
      description: row.description,
      imageUrl: row.image_url ?? '',
    }),
  );
}

// delete runs auto-deferred (ephemeral) — interaction.reply() below is monkey-patched to
// editReply() by index.js (invariant 2). This first reply is the confirmation prompt;
// the actual deletion happens in src/interactions/announcement.js's delconfirm handler.
async function executeDelete(interaction) {
  const id = Number.parseInt(interaction.options.getString('id'), 10);

  if (id === 0 || Number.isNaN(id)) {
    return interaction.reply({ content: '❌ Keine Announcements vorhanden.', flags: MessageFlags.Ephemeral });
  }

  const row = await announcements.getAnnouncement(interaction.guildId, id);
  if (!row) {
    return interaction.reply({ content: `❌ Announcement #${id} nicht gefunden.`, flags: MessageFlags.Ephemeral });
  }
  if (row.status === 'deleted') {
    return interaction.reply({ content: '❌ Bereits gelöscht.', flags: MessageFlags.Ephemeral });
  }

  return interaction.reply({
    content: '⚠️ Dieses Announcement endgültig löschen? Die Nachricht wird entfernt.',
    embeds: [buildDeletePreviewEmbed(row)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`announcement:delconfirm:yes:${row.id}`)
          .setLabel('🗑️ Endgültig löschen')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`announcement:delconfirm:no:${row.id}`)
          .setLabel('Abbrechen')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

// list runs auto-deferred (ephemeral) — same monkey-patched reply() as delete above.
async function executeList(interaction) {
  const rows = await announcements.listRecent(interaction.guildId, 10);

  if (rows.length === 0) {
    return interaction.reply({ content: 'Noch keine Announcements gespeichert.', flags: MessageFlags.Ephemeral });
  }

  const lines = rows.map((r) => {
    const link = `https://discord.com/channels/${interaction.guildId}/${r.channel_id}/${r.message_id}`;
    return `#${r.id} · **${truncate(r.title, 60)}** · <#${r.channel_id}> · <@${r.author_id}> · ${formatFullDate(r.created_at)} · [Link](${link})`;
  });

  const embed = new EmbedBuilder()
    .setTitle('📢 Announcements (letzte 10)')
    .setDescription(lines.join('\n'))
    .setFooter({ text: '🐾 Oreo' });

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('announcement')
    .setDescription('Verwaltet Announcements (Embed-Posts).')
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Postet eine neue Announcement (Embed) im gewählten Channel.')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Ziel-Channel (default: current)')
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText),
        )
        .addRoleOption((o) =>
          o
            .setName('ping')
            .setDescription("Optional: Rolle die geping't werden soll (inkl. @everyone)")
            .setRequired(false),
        )
        .addStringOption((o) =>
          o
            .setName('farbe')
            .setDescription('Farbe der Embed-Leiste (default: Blurple)')
            .setRequired(false)
            .addChoices(...COLOR_CHOICES),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('edit')
        .setDescription('Bearbeitet eine bestehende Announcement.')
        .addStringOption((o) =>
          o.setName('id').setDescription('Announcement-ID').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('Löscht eine bestehende Announcement.')
        .addStringOption((o) =>
          o.setName('id').setDescription('Announcement-ID').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Listet die letzten Announcements auf.')),

  requiredTier: 'moderator',

  // create + edit show a modal directly (no defer possible before showModal()) — see
  // index.js's auto-defer skip logic (invariant 1). delete/list go through the normal
  // auto-defer.
  showsModal: (interaction) => ['create', 'edit'].includes(interaction.options.getSubcommand(false)),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'create') return executeCreate(interaction);
    if (sub === 'edit') return executeEdit(interaction);
    if (sub === 'delete') return executeDelete(interaction);
    if (sub === 'list') return executeList(interaction);

    // Unreachable — every subcommand declared in `data` above has a branch.
    return interaction.reply({ content: '❌ Unbekannter Subcommand.', flags: MessageFlags.Ephemeral });
  },

  // Shared between edit + delete (both take an autocompleted `id` string option).
  async autocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused().toLowerCase();
      const rows = await announcements.listRecent(interaction.guildId, 25);

      const filtered = rows.filter((r) => r.title.toLowerCase().includes(focused));

      if (filtered.length === 0) {
        return interaction.respond([{ name: 'Keine Announcements gefunden', value: '0' }]);
      }

      const choices = filtered.map((r) => ({
        name: `#${r.id} · ${truncate(r.title, 60)} · ${formatFullDate(r.created_at)}`,
        value: String(r.id),
      }));

      await interaction.respond(choices.slice(0, 25));
    } catch (err) {
      console.error('[announcement] autocomplete failed:', err);
      await interaction.respond([]).catch(() => {});
    }
  },

  COLORS,
  buildAnnouncementModal,
};
