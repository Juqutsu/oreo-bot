const { SlashCommandBuilder, MessageFlags, EmbedBuilder, ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getPool } = require('../db');
const { invalidateGuildRowCache } = require('../config');
const { getVoiceConnection } = require('@discordjs/voice');
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
  { name: 'msglog', value: 'msglog' },
  { name: 'serverlog', value: 'serverlog' },
  { name: 'welcome', value: 'welcome' },
  { name: 'leave', value: 'leave' },
];

// type → DB-Spalte
const CHANNEL_COLUMN = {
  report: 'report_channel_id',
  modlog: 'mod_log_channel_id',
  msglog: 'msg_log_channel_id',
  serverlog: 'server_log_channel_id',
  welcome: 'welcome_channel_id',
  leave: 'leave_channel_id',
};

// type → User-facing Label
const CHANNEL_LABEL = {
  report: 'report',
  modlog: 'modlog',
  msglog: 'msglog',
  serverlog: 'serverlog',
  welcome: 'welcome',
  leave: 'leave',
};

const FEATURE_CHOICES = [
  { name: 'automod', value: 'automod' },
  { name: 'log_profile', value: 'log_profile' },
  { name: 'log_join_leave', value: 'log_join_leave' },
  { name: 'log_voice', value: 'log_voice' },
  { name: 'log_invite', value: 'log_invite' },
  { name: 'log_roles', value: 'log_roles' },
  { name: 'log_messages', value: 'log_messages' },
];

// feature → DB-Spalte
const FEATURE_COLUMN = {
  automod: 'automod_enabled',
  log_profile: 'log_profile_enabled',
  log_join_leave: 'log_join_leave_enabled',
  log_voice: 'log_voice_enabled',
  log_invite: 'log_invite_enabled',
  log_roles: 'log_roles_enabled',
  log_messages: 'log_messages_enabled',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Konfiguration des Bots für diesen Server.')
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
    .addSubcommandGroup((group) =>
      group.setName('security').setDescription('Sicherheitseinstellungen')
        .addSubcommand((sub) =>
          sub.setName('set-age').setDescription('Setzt die Mindestalter-Prüfung für beigetretene Accounts.')
            .addIntegerOption((o) => o.setName('days').setDescription('Mindestalter in Tagen (0 = deaktiviert)').setRequired(true).setMinValue(0).setMaxValue(30))
        )
        .addSubcommand((sub) =>
          sub.setName('set-warn-decay').setDescription('Setzt die Zeit in Tagen, nach der Verwarnungen verfallen.')
            .addIntegerOption((o) => o.setName('days').setDescription('Tage bis zum Verfall (0 = deaktiviert)').setRequired(true).setMinValue(0).setMaxValue(365))
        )
        .addSubcommand((sub) =>
          sub.setName('set-captcha').setDescription('Aktiviert/deaktiviert die Captcha-Verifizierung bei Beitritt.')
            .addBooleanOption((o) => o.setName('enabled').setDescription('Aktiviert?').setRequired(true))
            .addRoleOption((o) => o.setName('role').setDescription('Rolle, die nach Verifizierung vergeben wird').setRequired(false))
            .addChannelOption((o) => o.setName('channel').setDescription('Kanal für die globale Verifizierung').setRequired(false).addChannelTypes(ChannelType.GuildText))
        )
        .addSubcommand((sub) =>
          sub.setName('add-verified-role').setDescription('Fügt eine Rolle hinzu, die nach erfolgreicher Verifizierung vergeben wird.')
            .addRoleOption((o) => o.setName('role').setDescription('Rolle').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub.setName('remove-verified-role').setDescription('Entfernt eine Rolle aus den verifizierten Rollen.')
            .addRoleOption((o) => o.setName('role').setDescription('Rolle').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub.setName('add-unverified-role').setDescription('Fügt eine Rolle hinzu, die nach erfolgreicher Verifizierung entfernt wird.')
            .addRoleOption((o) => o.setName('role').setDescription('Rolle').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub.setName('remove-unverified-role').setDescription('Entfernt eine Rolle aus den zu löschenden unverifizierten Rollen.')
            .addRoleOption((o) => o.setName('role').setDescription('Rolle').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub.setName('unset-verified-roles').setDescription('Deaktiviert alle Rollen, die nach erfolgreicher Verifizierung vergeben werden.')
        )
        .addSubcommand((sub) =>
          sub.setName('unset-unverified-roles').setDescription('Deaktiviert alle Rollen, die nach erfolgreicher Verifizierung entfernt werden.')
        )
        .addSubcommand((sub) =>
          sub.setName('set-toxicity').setDescription('Aktiviert/deaktiviert den Toxizitäts-Filter.')
            .addBooleanOption((o) => o.setName('enabled').setDescription('Aktiviert?').setRequired(true))
            .addStringOption((o) => o.setName('action').setDescription('Sanktion bei Verstoß').setRequired(false).addChoices(
              { name: 'delete', value: 'delete' },
              { name: 'warn', value: 'warn' },
              { name: 'mute', value: 'mute' }
            ))
        )
        .addSubcommand((sub) =>
          sub.setName('add-bad-word').setDescription('Fügt ein Wort zur Blacklist des Toxizitäts-Filters hinzu.')
            .addStringOption((o) => o.setName('word').setDescription('Das verbotene Wort').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub.setName('remove-bad-word').setDescription('Entfernt ein Wort von der Blacklist des Toxizitäts-Filters.')
            .addStringOption((o) => o.setName('word').setDescription('Das verbotene Wort').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub.setName('list-bad-words').setDescription('Listet alle blockierten Wörter des Toxizitäts-Filters auf.')
        )
    )
    .addSubcommandGroup((group) =>
      group.setName('welcome').setDescription('Willkommens-System konfigurieren')
        .addSubcommand((sub) =>
          sub.setName('set').setDescription('Konfiguriert das Willkommens-System.')
            .addBooleanOption((o) => o.setName('enabled').setDescription('Aktivieren oder Deaktivieren').setRequired(false))
            .addChannelOption((o) => o.setName('channel').setDescription('Kanal für Willkommenskarten').setRequired(false).addChannelTypes(ChannelType.GuildText))
            .addStringOption((o) => o.setName('message').setDescription('Nachrichtentext (Platzhalter: {user}, {username}, {server}, {memberCount})').setRequired(false).setMaxLength(255))
            .addStringOption((o) => o.setName('background').setDescription('Bild-URL für den Karten-Hintergrund (oder "none" zum Löschen)').setRequired(false).setMaxLength(512))
            .addBooleanOption((o) => o.setName('banner').setDescription('Banner-Bild mitsenden (Ja/Nein)').setRequired(false))
            .addStringOption((o) => o.setName('bannertext').setDescription('Text auf dem Banner (z.B. Willkommen!)').setRequired(false).setMaxLength(64))
            .addStringOption((o) => o.setName('accent').setDescription('Akzentfarbe (z.B. #5865f2)').setRequired(false).setMaxLength(7))
            .addStringOption((o) => o.setName('textcolor').setDescription('Textfarbe (z.B. #7289da)').setRequired(false).setMaxLength(7))
        )
        .addSubcommand((sub) =>
          sub.setName('test').setDescription('Generiert und sendet eine Test-Willkommenskarte.')
        )
        .addSubcommand((sub) =>
          sub.setName('edit').setDescription('Öffnet ein Modal zur Konfiguration von Design, Text & Farben.')
        )
        .addSubcommand((sub) =>
          sub.setName('set-join-role').setDescription('Setzt die Rolle, die beim Beitritt automatisch vergeben wird.')
            .addRoleOption((o) => o.setName('role').setDescription('Rolle').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub.setName('unset-join-role').setDescription('Deaktiviert die automatische Rollenvergabe beim Beitritt.')
        )
        .addSubcommand((sub) =>
          sub.setName('add-join-role').setDescription('Fügt eine Rolle hinzu, die beim Beitritt automatisch vergeben wird.')
            .addRoleOption((o) => o.setName('role').setDescription('Rolle').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub.setName('remove-join-role').setDescription('Entfernt eine Rolle aus der automatischen Beitrittsvergabe.')
            .addRoleOption((o) => o.setName('role').setDescription('Rolle').setRequired(true))
        )
    )
    .addSubcommandGroup((group) =>
      group.setName('leave').setDescription('Leave-System konfigurieren')
        .addSubcommand((sub) =>
          sub.setName('set').setDescription('Konfiguriert das Leave-System.')
            .addBooleanOption((o) => o.setName('enabled').setDescription('Aktivieren oder Deaktivieren').setRequired(false))
            .addChannelOption((o) => o.setName('channel').setDescription('Kanal für Leave-Karten').setRequired(false).addChannelTypes(ChannelType.GuildText))
            .addStringOption((o) => o.setName('message').setDescription('Nachrichtentext (Platzhalter: {user}, {username}, {server}, {memberCount})').setRequired(false).setMaxLength(255))
            .addStringOption((o) => o.setName('background').setDescription('Bild-URL für den Karten-Hintergrund (oder "none" zum Löschen)').setRequired(false).setMaxLength(512))
            .addBooleanOption((o) => o.setName('banner').setDescription('Banner-Bild mitsenden (Ja/Nein)').setRequired(false))
            .addStringOption((o) => o.setName('bannertext').setDescription('Text auf dem Banner (z.B. Ciao!)').setRequired(false).setMaxLength(64))
            .addStringOption((o) => o.setName('accent').setDescription('Akzentfarbe (z.B. #e74c3c)').setRequired(false).setMaxLength(7))
            .addStringOption((o) => o.setName('textcolor').setDescription('Textfarbe (z.B. #e74c3c)').setRequired(false).setMaxLength(7))
        )
        .addSubcommand((sub) =>
          sub.setName('test').setDescription('Generiert und sendet eine Test-Leave-Karte.')
        )
        .addSubcommand((sub) =>
          sub.setName('edit').setDescription('Öffnet ein Modal zur Konfiguration von Design, Text & Farben.')
        )
    )
    .addSubcommandGroup((group) =>
      group.setName('voice').setDescription('Voice-Recognition-System konfigurieren')
        .addSubcommand((sub) =>
          sub.setName('set').setDescription('Konfiguriert das Voice-Recognition-System.')
            .addBooleanOption((o) => o.setName('enabled').setDescription('Aktivieren oder Deaktivieren').setRequired(false))
            .addChannelOption((o) => o.setName('channel').setDescription('Kanal für Voice-Meldungen (Team-Chat)').setRequired(false).addChannelTypes(ChannelType.GuildText))
            .addStringOption((o) => o.setName('message').setDescription('Der lustige Satz, der gesendet wird').setRequired(false).setMaxLength(255))
        )
    )
    .addSubcommandGroup((group) =>
      group.setName('levelperms').setDescription('Verknüpft Ramen-Levels mit Rollen und Oreo-Rechten.')
        .addSubcommand((sub) =>
          sub.setName('set').setDescription('Setzt die Level-Rechte-Verknüpfung.')
            .addIntegerOption((o) => o.setName('level').setDescription('Erforderliches Level für Supporter-Rechte').setRequired(true).setMinValue(1))
            .addRoleOption((o) => o.setName('role').setDescription('Die Rolle, die automatisch vergeben wird (optional)').setRequired(false))
        )
        .addSubcommand((sub) =>
          sub.setName('unset').setDescription('Entfernt die Level-Rechte-Verknüpfung.')
        )
    )
    .addSubcommand((sub) =>
      sub.setName('show').setDescription('Zeigt die komplette Server-Konfiguration.')
    ),

  requiredTier: 'owner',

  // Only `welcome edit` / `leave edit` show a modal directly (no defer possible before
  // showModal()) — every other subcommand goes through the normal auto-defer path.
  showsModal: (interaction) => interaction.options.getSubcommand(false) === 'edit',

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

    if (group === 'security') {
      if (sub === 'set-age') return handleSecuritySetAge(interaction);
      if (sub === 'set-warn-decay') return handleSecuritySetWarnDecay(interaction);
      if (sub === 'set-captcha') return handleSecuritySetCaptcha(interaction);
      if (sub === 'add-verified-role') return handleSecurityAddVerifiedRole(interaction);
      if (sub === 'remove-verified-role') return handleSecurityRemoveVerifiedRole(interaction);
      if (sub === 'add-unverified-role') return handleSecurityAddUnverifiedRole(interaction);
      if (sub === 'remove-unverified-role') return handleSecurityRemoveUnverifiedRole(interaction);
      if (sub === 'unset-verified-roles') return handleSecurityUnsetVerifiedRoles(interaction);
      if (sub === 'unset-unverified-roles') return handleSecurityUnsetUnverifiedRoles(interaction);
      if (sub === 'set-toxicity') return handleSecuritySetToxicity(interaction);
      if (sub === 'add-bad-word') return handleSecurityAddBadWord(interaction);
      if (sub === 'remove-bad-word') return handleSecurityRemoveBadWord(interaction);
      if (sub === 'list-bad-words') return handleSecurityListBadWords(interaction);
    }

    if (group === 'welcome') {
      if (sub === 'set')  return handleWelcomeSet(interaction);
      if (sub === 'test') return handleWelcomeTest(interaction);
      if (sub === 'edit') return handleWelcomeEdit(interaction);
      if (sub === 'set-join-role') return handleWelcomeSetJoinRole(interaction);
      if (sub === 'unset-join-role') return handleWelcomeUnsetJoinRole(interaction);
      if (sub === 'add-join-role') return handleWelcomeAddJoinRole(interaction);
      if (sub === 'remove-join-role') return handleWelcomeRemoveJoinRole(interaction);
    }

    if (group === 'leave') {
      if (sub === 'set')  return handleLeaveSet(interaction);
      if (sub === 'test') return handleLeaveTest(interaction);
      if (sub === 'edit') return handleLeaveEdit(interaction);
    }

    if (group === 'voice') {
      if (sub === 'set')  return handleVoiceSet(interaction);
    }

    if (group === 'levelperms') {
      if (sub === 'set')   return handleLevelPermsSet(interaction);
      if (sub === 'unset') return handleLevelPermsUnset(interaction);
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

  // Report-Channel Permission-Check
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
    invalidateGuildRowCache(interaction.guildId);
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
    invalidateGuildRowCache(interaction.guildId);
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
      'SELECT mod_log_channel_id, report_channel_id, msg_log_channel_id, server_log_channel_id, welcome_channel_id, leave_channel_id FROM guilds WHERE guild_id = ?',
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
  const msglogId = row?.msg_log_channel_id ? String(row.msg_log_channel_id) : null;
  const serverlogId = row?.server_log_channel_id ? String(row.server_log_channel_id) : null;
  const welcomeId = row?.welcome_channel_id ? String(row.welcome_channel_id) : null;
  const leaveId = row?.leave_channel_id ? String(row.leave_channel_id) : null;

  const reportLine = reportId ? `<#${reportId}>` : '(nicht konfiguriert)';
  let modlogLine;
  if (modlogDbId) modlogLine = `<#${modlogDbId}>`;
  else if (modlogEnvId) modlogLine = `<#${modlogEnvId}> *(env-Fallback)*`;
  else modlogLine = '(nicht konfiguriert)';
  const msglogLine = msglogId ? `<#${msglogId}>` : '(nicht konfiguriert)';
  const serverlogLine = serverlogId ? `<#${serverlogId}>` : '(nicht konfiguriert)';
  const welcomeLine = welcomeId ? `<#${welcomeId}>` : '(nicht konfiguriert)';
  const leaveLine = leaveId ? `<#${leaveId}>` : '(nicht konfiguriert)';

  const embed = new EmbedBuilder()
    .setTitle('🔧 Channel-Konfiguration')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Report-Channel',  value: reportLine, inline: false },
      { name: 'Mod-Log-Channel', value: modlogLine, inline: false },
      { name: 'Message-Log-Channel', value: msglogLine, inline: false },
      { name: 'Server-Log-Channel', value: serverlogLine, inline: false },
      { name: 'Welcome-Channel', value: welcomeLine, inline: false },
      { name: 'Leave-Channel', value: leaveLine, inline: false },
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
    invalidateGuildRowCache(interaction.guildId);
  } catch (err) {
    console.error('/config feature set DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  let message;
  if (name === 'automod' && value) {
    message = `Feature \`automod\` aktiviert.`;
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

async function handleSecuritySetAge(interaction) {
  const days = interaction.options.getInteger('days');
  const pool = getPool();
  try {
    await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [interaction.guildId]);
    await pool.execute(
      'UPDATE guilds SET min_account_age_days = ? WHERE guild_id = ?',
      [days, interaction.guildId]
    );
    invalidateGuildRowCache(interaction.guildId);
  } catch (err) {
    console.error('/config security set-age DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const message = days > 0
    ? `✅ Mindestalter für beigetretene Accounts auf **${days} Tage** gesetzt. Jüngere Accounts werden im Mod-Log geflaggt.`
    : '✅ Mindestalter-Prüfung deaktiviert.';
  return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}

async function handleSecuritySetWarnDecay(interaction) {
  const days = interaction.options.getInteger('days');
  const pool = getPool();
  try {
    await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [interaction.guildId]);
    await pool.execute(
      'UPDATE guilds SET warn_decay_days = ? WHERE guild_id = ?',
      [days, interaction.guildId]
    );
    invalidateGuildRowCache(interaction.guildId);
  } catch (err) {
    console.error('/config security set-warn-decay DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const message = days > 0
    ? `✅ Verwarnungs-Verfall auf **${days} Tage** gesetzt. Ältere Verwarnungen verfallen automatisch.`
    : '✅ Verwarnungs-Verfall deaktiviert (Verwarnungen verfallen nie).';
  return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}

async function handleSecuritySetCaptcha(interaction) {
  const enabled = interaction.options.getBoolean('enabled');
  const role = interaction.options.getRole('role');
  const channel = interaction.options.getChannel('channel');
  const config = require('../config');
  const guild = interaction.guild;

  let verifiedRole = role;
  let captchaChannel = channel;
  let permError = null;

  try {
    const pool = getPool();
    await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [interaction.guildId]);
    await config.setCaptchaEnabled(interaction.guildId, enabled);
    if (role) {
      await config.setVerifiedRoleId(interaction.guildId, role.id);
    }
  } catch (err) {
    console.error('/config security set-captcha DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    if (enabled) {
      // 1. Resolve/create verified role
      if (!verifiedRole) {
        const verifiedRoleId = await config.getVerifiedRoleId(guild.id);
        if (verifiedRoleId) {
          verifiedRole = guild.roles.cache.get(verifiedRoleId) || await guild.roles.fetch(verifiedRoleId).catch(() => null);
        }
      }
      if (!verifiedRole) {
        verifiedRole = guild.roles.cache.find((r) => r.name === 'Member');
      }
      if (!verifiedRole) {
        verifiedRole = await guild.roles.create({
          name: 'Member',
          color: 0x2ecc71,
          permissions: [PermissionFlagsBits.ViewChannel],
          reason: 'Oreo Verifizierungs-Rolle Setup',
        });
        await config.setVerifiedRoleId(guild.id, verifiedRole.id);
      }

      // 2. Resolve/create global captcha channel
      if (!captchaChannel) {
        const captchaChannelId = await config.getCaptchaChannelId(guild.id);
        if (captchaChannelId) {
          captchaChannel = guild.channels.cache.get(captchaChannelId) || await guild.channels.fetch(captchaChannelId).catch(() => null);
        }
      }
      if (!captchaChannel) {
        captchaChannel = guild.channels.cache.find((c) => c.name === 'verify' || c.name === 'verifizierung');
      }
      if (!captchaChannel) {
        captchaChannel = await guild.channels.create({
          name: 'verify',
          type: ChannelType.GuildText,
          reason: 'Oreo Globaler Verifizierungs-Channel Setup',
        });
      }

      if (captchaChannel) {
        await config.setCaptchaChannelId(guild.id, captchaChannel.id);

        // Make sure @everyone can view this channel explicitly
        const everyone = guild.roles.everyone;
        await captchaChannel.permissionOverwrites.create(everyone.id, {
          ViewChannel: true,
          SendMessages: false,
          AddReactions: false,
          ReadMessageHistory: true,
        }, { reason: 'Oreo: Globaler Verifizierungs-Channel Sichtbarkeit für Unverifizierte' }).catch(() => null);

        // Send captcha prompt if not already exists
        const messages = await captchaChannel.messages.fetch({ limit: 50 }).catch(() => null);
        let existingMsg = null;
        if (messages) {
          existingMsg = messages.find(m => m.author.id === guild.members.me.id && m.components.some(row => row.components.some(c => c.customId === 'captcha_global_start')));
        }
        if (!existingMsg) {
          const embed = new EmbedBuilder()
            .setTitle('🔐 Server-Verifizierung')
            .setColor(0x3498db)
            .setDescription(`Willkommen auf **${guild.name}**!\n\nUm Zugriff auf den Server zu erhalten, musst du dich verifizieren.\n\nKlicke auf den Button unten, um das Captcha zu starten.`)
            .setFooter({ text: '🐾 Oreo • Verifizierung' })
            .setTimestamp();

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`captcha_global_start`)
              .setLabel('Verifizierung starten')
              .setStyle(ButtonStyle.Primary)
          );

          await captchaChannel.send({
            embeds: [embed],
            components: [row]
          });
        }
      }

      // Remove ViewChannel from @everyone globally
      const everyone = guild.roles.everyone;
      if (everyone.permissions.has(PermissionFlagsBits.ViewChannel)) {
        const newPerms = everyone.permissions.remove(PermissionFlagsBits.ViewChannel);
        await everyone.setPermissions(newPerms, 'Oreo: Captcha-Schutz aktiviert');
      }

      // Add ViewChannel to the verified role globally
      if (verifiedRole && !verifiedRole.permissions.has(PermissionFlagsBits.ViewChannel)) {
        const newPerms = verifiedRole.permissions.add(PermissionFlagsBits.ViewChannel);
        await verifiedRole.setPermissions(newPerms, 'Oreo: Captcha-Schutz aktiviert');
      }
    } else {
      // Disable captcha
      const captchaChannelId = await config.getCaptchaChannelId(guild.id);
      if (captchaChannelId) {
        const chan = guild.channels.cache.get(captchaChannelId) || await guild.channels.fetch(captchaChannelId).catch(() => null);
        if (chan) {
          const messages = await chan.messages.fetch({ limit: 50 }).catch(() => null);
          if (messages) {
            const msgToDelete = messages.find(m => m.author.id === guild.members.me.id && m.components.some(row => row.components.some(c => c.customId === 'captcha_global_start')));
            if (msgToDelete) {
              await msgToDelete.delete().catch(() => null);
            }
          }
        }
      }
      await config.setCaptchaChannelId(guild.id, null);

      // Restore ViewChannel to @everyone globally
      const everyone = guild.roles.everyone;
      if (!everyone.permissions.has(PermissionFlagsBits.ViewChannel)) {
        const newPerms = everyone.permissions.add(PermissionFlagsBits.ViewChannel);
        await everyone.setPermissions(newPerms, 'Oreo: Captcha-Schutz deaktiviert');
      }
    }
  } catch (err) {
    console.error('[captcha-setup] failed to configure role permissions:', err);
    permError = err.message;
  }

  const roleDisplay = verifiedRole ? ` mit Rolle <@&${verifiedRole.id}>` : (role ? ` mit Rolle <@&${role.id}>` : '');
  const chanDisplay = captchaChannel ? ` im Kanal <#${captchaChannel.id}>` : '';
  let message = enabled
    ? `✅ Captcha-Verifizierung bei Server-Beitritt **aktiviert**${roleDisplay}${chanDisplay}.`
    : '✅ Captcha-Verifizierung **deaktiviert**.';

  if (permError) {
    message += `\n\n⚠️ **Hinweis:** Die Berechtigungen konnten nicht automatisch angepasst werden (${permError}). Bitte stelle sicher, dass der Bot die Berechtigung 'Rollen verwalten' und 'Kanäle verwalten' hat und seine Rolle in den Einstellungen ganz oben steht.`;
  } else if (enabled) {
    message += `\n🔒 Kanäle wurden für @everyone verborgen und sind nun erst nach dem Lösen des Captchas (über die Rolle) sichtbar.`;
  } else {
    message += `\n🔓 Kanäle sind wieder für @everyone sichtbar gemacht worden.`;
  }

  return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}

async function handleSecuritySetToxicity(interaction) {
  const enabled = interaction.options.getBoolean('enabled');
  const action = interaction.options.getString('action');
  const config = require('../config');

  try {
    const pool = getPool();
    await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [interaction.guildId]);
    await config.setToxicityEnabled(interaction.guildId, enabled);
    if (action) {
      await config.setToxicityAction(interaction.guildId, action);
    }
  } catch (err) {
    console.error('/config security set-toxicity DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const act = action || 'warn';
  const message = enabled
    ? `✅ Anti-Toxizitäts-Filter **aktiviert** (Aktion bei Verstoß: **${act}**).`
    : '✅ Anti-Toxizitäts-Filter **deaktiviert**.';
  return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}

async function handleSecurityAddBadWord(interaction) {
  const word = interaction.options.getString('word');
  const config = require('../config');

  try {
    const pool = getPool();
    await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [interaction.guildId]);
    await config.addBadWord(interaction.guildId, word);
  } catch (err) {
    console.error('/config security add-bad-word DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: `✅ Wort \`${word.toLowerCase()}\` zur Toxizitäts-Blacklist hinzugefügt.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSecurityRemoveBadWord(interaction) {
  const word = interaction.options.getString('word');
  const config = require('../config');

  try {
    await config.removeBadWord(interaction.guildId, word);
  } catch (err) {
    console.error('/config security remove-bad-word DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: `✅ Wort \`${word.toLowerCase()}\` von der Toxizitäts-Blacklist entfernt.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSecurityListBadWords(interaction) {
  const config = require('../config');
  let words = [];

  try {
    words = await config.getBadWords(interaction.guildId);
  } catch (err) {
    console.error('/config security list-bad-words DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (words.length === 0) {
    return interaction.reply({
      content: 'Die Blacklist ist aktuell leer. Verwende `/config security add-bad-word word:<text>` um Wörter hinzuzufügen.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('📝 Toxizitäts-Filter Blacklist')
    .setColor(0x5865f2)
    .setDescription(words.map((w) => `• \`${w}\``).join('\n'))
    .setFooter({ text: `Insgesamt ${words.length} Wort/Wörter | 🐾 Oreo` });

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleShow(interaction) {
  let guildRow;
  let roleRows;
  try {
    const pool = getPool();
    const [gRows] = await pool.execute(
      'SELECT * FROM guilds WHERE guild_id = ?',
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
  const msglogId = guildRow?.msg_log_channel_id ? String(guildRow.msg_log_channel_id) : null;
  const serverlogId = guildRow?.server_log_channel_id ? String(guildRow.server_log_channel_id) : null;
  const welcomeId = guildRow?.welcome_channel_id ? String(guildRow.welcome_channel_id) : null;
  const leaveId = guildRow?.leave_channel_id ? String(guildRow.leave_channel_id) : null;

  const reportLine = reportId ? `<#${reportId}>` : '(nicht konfiguriert)';
  let modlogLine;
  if (modlogDbId) modlogLine = `<#${modlogDbId}>`;
  else if (modlogEnvId) modlogLine = `<#${modlogEnvId}> *(env-Fallback)*`;
  else modlogLine = '(nicht konfiguriert)';
  const msglogLine = msglogId ? `<#${msglogId}>` : '(nicht konfiguriert)';
  const serverlogLine = serverlogId ? `<#${serverlogId}>` : '(nicht konfiguriert)';
  const welcomeChannelLine = welcomeId ? `<#${welcomeId}>` : '(nicht konfiguriert)';
  const leaveChannelLine = leaveId ? `<#${leaveId}>` : '(nicht konfiguriert)';

  // Features
  const automodOn = Boolean(guildRow?.automod_enabled);
  const automodLine = automodOn ? '✅ aktiv' : '❌ deaktiviert';
  const minAge = guildRow?.min_account_age_days ? Number(guildRow.min_account_age_days) : 0;
  const minAgeLine = minAge > 0 ? `⚠️ Flag unter ${minAge} Tagen` : '❌ inaktiv';
  const warnDecay = guildRow?.warn_decay_days ? Number(guildRow.warn_decay_days) : 0;
  const warnDecayLine = warnDecay > 0 ? `${warnDecay} Tage` : '❌ inaktiv';
  const mutedRoleId = guildRow?.muted_role_id ? String(guildRow.muted_role_id) : null;
  const mutedRoleLine = mutedRoleId ? `<@&${mutedRoleId}>` : '(nicht konfiguriert)';
  const captchaOn = Boolean(guildRow?.captcha_enabled);
  const config = require('../config');
  const joinRoleIds = await config.getJoinRoleIds(interaction.guildId);
  const verifiedRoleIds = await config.getVerifiedRoleIds(interaction.guildId);
  const unverifiedRoleIds = await config.getUnverifiedRoleIds(interaction.guildId);

  const joinRolesLine = joinRoleIds.length > 0 ? joinRoleIds.map(id => `<@&${id}>`).join(', ') : '(nicht konfiguriert)';
  const verifiedRolesLine = verifiedRoleIds.length > 0 ? verifiedRoleIds.map(id => `<@&${id}>`).join(', ') : '(keine Rolle)';
  const unverifiedRolesLine = unverifiedRoleIds.length > 0 ? unverifiedRoleIds.map(id => `<@&${id}>`).join(', ') : '(keine Rolle)';

  const captchaEnabledLine = captchaOn
    ? `✅ aktiv (Geben: ${verifiedRolesLine} | Entfernen: ${unverifiedRolesLine})`
    : '❌ deaktiviert';
  const toxicityOn = Boolean(guildRow?.toxicity_enabled);
  const toxicityActionText = guildRow?.toxicity_action ?? 'warn';
  const toxicityEnabledLine = toxicityOn
    ? `✅ aktiv (Aktion: **${toxicityActionText}**)`
    : '❌ deaktiviert';

  const welcomeOn = Boolean(guildRow?.welcome_enabled);
  const welcomeMessage = guildRow?.welcome_message ?? 'Willkommen {user} auf {server}!';
  const welcomeBg = guildRow?.welcome_bg_url ? `[Link](${guildRow.welcome_bg_url})` : 'Standard';
  const welcomeAccent = guildRow?.welcome_accent_color ?? '#5865f2';
  const welcomeTextcolor = guildRow?.welcome_text_color ?? '#7289da';
  const welcomeBannerEnabled = guildRow?.welcome_banner_enabled !== 0;
  const welcomeBannerText = guildRow?.welcome_banner_text ?? 'WILLKOMMEN';
  const welcomeLineShow = welcomeOn ? `✅ aktiv (Msg: "${welcomeMessage}", Banner: ${welcomeBannerEnabled ? 'Ja' : 'Nein'}, Banner-Text: "${welcomeBannerText}", BG: ${welcomeBg}, Accent: \`${welcomeAccent}\`, Text: \`${welcomeTextcolor}\`)` : '❌ deaktiviert';

  const leaveOn = Boolean(guildRow?.leave_enabled);
  const leaveMessage = guildRow?.leave_message ?? '{user} hat den Server verlassen.';
  const leaveBg = guildRow?.leave_bg_url ? `[Link](${guildRow.leave_bg_url})` : 'Standard';
  const leaveAccent = guildRow?.leave_accent_color ?? '#e74c3c';
  const leaveTextcolor = guildRow?.leave_text_color ?? '#e74c3c';
  const leaveBannerEnabled = guildRow?.leave_banner_enabled !== 0;
  const leaveBannerText = guildRow?.leave_banner_text ?? 'AUF WIEDERSEHEN';
  const leaveLineShow = leaveOn ? `✅ aktiv (Msg: "${leaveMessage}", Banner: ${leaveBannerEnabled ? 'Ja' : 'Nein'}, Banner-Text: "${leaveBannerText}", BG: ${leaveBg}, Accent: \`${leaveAccent}\`, Text: \`${leaveTextcolor}\`)` : '❌ deaktiviert';

  const voiceRecOn = Boolean(guildRow?.voice_rec_enabled);
  const voiceRecChannelId = guildRow?.voice_rec_channel_id ? String(guildRow.voice_rec_channel_id) : null;
  const voiceRecMessage = guildRow?.voice_rec_message ?? 'Wer hat Oreo Ban gerufen? Ab ins Gefängnis!';
  const voiceLineShow = voiceRecOn
    ? `✅ aktiv (Kanal: ${voiceRecChannelId ? `<#${voiceRecChannelId}>` : '(nicht konfiguriert)'}, Satz: "${voiceRecMessage}")`
    : '❌ deaktiviert';

  // Server Log Toggles
  const logProfileOn = Boolean(guildRow?.log_profile_enabled);
  const logJoinLeaveOn = Boolean(guildRow?.log_join_leave_enabled);
  const logVoiceOn = Boolean(guildRow?.log_voice_enabled);
  const logInviteOn = Boolean(guildRow?.log_invite_enabled);
  const logRolesOn = Boolean(guildRow?.log_roles_enabled);
  const logMessagesOn = Boolean(guildRow?.log_messages_enabled);
  const serverLogToggles = `Profile: ${logProfileOn ? '✅' : '❌'} | Joins/Leaves: ${logJoinLeaveOn ? '✅' : '❌'} | Voice: ${logVoiceOn ? '✅' : '❌'} | Invites: ${logInviteOn ? '✅' : '❌'} | Roles: ${logRolesOn ? '✅' : '❌'} | Messages: ${logMessagesOn ? '✅' : '❌'}`;

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

  // Eskalations-Regeln für show
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

  // Link Level Perms candidacy role check (Oreo synergy)
  const levelPermsRequired = guildRow?.level_supporter_required;
  const candidacyRoleId = guildRow?.candidacy_role_id ? String(guildRow.candidacy_role_id) : null;
  const levelPermsLine = levelPermsRequired 
    ? `Level ${levelPermsRequired} (Rolle: ${candidacyRoleId ? `<@&${candidacyRoleId}>` : '(keine Rolle)'})` 
    : '❌ deaktiviert';

  const embed = new EmbedBuilder()
    .setTitle('🛡️ Server-Konfiguration')
    .setColor(0x5865f2)
    .addFields(
      { name: '📺 Channels',     value: `Report: ${reportLine}\nMod-Log: ${modlogLine}\nMsg-Log: ${msglogLine}\nServer-Log: ${serverlogLine}\nWelcome-Channel: ${welcomeChannelLine}\nLeave-Channel: ${leaveChannelLine}`, inline: false },
      { name: '⚙️ Sicherheits- & Mod-Features', value: `Automod: ${automodLine}\nKontoalters-Prüfung: ${minAgeLine}\nVerwarnungs-Verfall: ${warnDecayLine}\nMute-Rolle: ${mutedRoleLine}\nToxizitäts-Filter: ${toxicityEnabledLine}\nVoice-Recognition: ${voiceLineShow}\nLevel-Perms: ${levelPermsLine}`, inline: false },
      { name: '🔐 Beitritt & Verifizierung', value: `Captcha-Verifizierung: ${captchaEnabledLine}\nJoin-Rolle(n): ${joinRolesLine}`, inline: false },
      { name: '👋 Willkommens- & Leave-System', value: `Welcome-Card: ${welcomeLineShow}\nLeave-Card: ${leaveLineShow}`, inline: false },
      { name: '📁 Server-Logs',  value: serverLogToggles, inline: false },
      { name: '🎯 Eskalation',   value: escalationValue,                                  inline: false },
      { name: '📊 Statistiken',  value: `Nächste Case-Nr: ${nextCase}`,                  inline: false },
      { name: '🔐 Rollen-Tiers', value: rolesValue,                                       inline: false },
    )
    .setFooter({ text: '🐾 Oreo' });

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleWelcomeSet(interaction) {
  const enabled = interaction.options.getBoolean('enabled');
  const channel = interaction.options.getChannel('channel');
  const message = interaction.options.getString('message');
  const background = interaction.options.getString('background');
  const banner = interaction.options.getBoolean('banner');
  const bannertext = interaction.options.getString('bannertext');
  const accent = interaction.options.getString('accent');
  const textcolor = interaction.options.getString('textcolor');

  if (enabled === null && channel === null && message === null && background === null && banner === null && bannertext === null && accent === null && textcolor === null) {
    return interaction.reply({
      content: '❌ Bitte gib mindestens eine Option an, die du konfigurieren möchtest.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Validate hex colors
  const HEX_COLOR_REGEX = /^#[0-9A-F]{6}$/i;
  if (accent && !HEX_COLOR_REGEX.test(accent)) {
    return interaction.reply({
      content: '❌ Die Akzentfarbe muss ein gültiger Hex-Code sein (z.B. `#5865f2`).',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (textcolor && !HEX_COLOR_REGEX.test(textcolor)) {
    return interaction.reply({
      content: '❌ Die Textfarbe muss ein gültiger Hex-Code sein (z.B. `#7289da`).',
      flags: MessageFlags.Ephemeral,
    });
  }

  const pool = getPool();
  try {
    await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [interaction.guildId]);
  } catch (err) {
    console.error('/config welcome set DB error (init):', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const config = require('../config');
  const updates = [];

  try {
    if (enabled !== null) {
      await config.setWelcomeEnabled(interaction.guildId, enabled);
      updates.push(`Aktiviert: **${enabled ? 'Ja' : 'Nein'}**`);
    }
    if (channel !== null) {
      await config.setWelcomeChannelId(interaction.guildId, channel.id);
      updates.push(`Kanal: <#${channel.id}>`);
    }
    if (message !== null) {
      await config.setWelcomeMessage(interaction.guildId, message);
      updates.push(`Nachricht: *${message}*`);
    }
    if (background !== null) {
      const cleanBg = background.trim() === 'none' || background.trim() === '' ? null : background;
      await config.setWelcomeBgUrl(interaction.guildId, cleanBg);
      updates.push(`Hintergrund: ${cleanBg ? `[Link](${cleanBg})` : 'Standard-Verlauf'}`);
    }
    if (banner !== null) {
      await config.setWelcomeBannerEnabled(interaction.guildId, banner);
      updates.push(`Banner mitsenden: **${banner ? 'Ja' : 'Nein'}**`);
    }
    if (bannertext !== null) {
      await config.setWelcomeBannerText(interaction.guildId, bannertext);
      updates.push(`Banner-Text: *${bannertext}*`);
    }
    if (accent !== null) {
      await config.setWelcomeAccentColor(interaction.guildId, accent);
      updates.push(`Akzentfarbe: \`${accent}\``);
    }
    if (textcolor !== null) {
      await config.setWelcomeTextColor(interaction.guildId, textcolor);
      updates.push(`Textfarbe: \`${textcolor}\``);
    }
  } catch (err) {
    console.error('/config welcome set DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: `✅ **Willkommens-System konfiguriert:**\n${updates.map((u) => `• ${u}`).join('\n')}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleWelcomeTest(interaction) {
  const config = require('../config');

  try {
    const channelId = await config.getWelcomeChannelId(interaction.guildId);
    const welcomeMessageTemplate = await config.getWelcomeMessage(interaction.guildId);
    const bgUrl = await config.getWelcomeBgUrl(interaction.guildId);
    const bannerEnabled = await config.isWelcomeBannerEnabled(interaction.guildId);

    const { formatWelcomeMessage } = require('../welcomeCard');
    const messageText = await formatWelcomeMessage(welcomeMessageTemplate, interaction.member);

    const sendPayload = { content: messageText };
    const replyFiles = [];

    if (bannerEnabled) {
      const { generateCard } = require('../welcomeCard');
      const cardBuffer = await generateCard(interaction.user, interaction.guild, 'welcome', bgUrl);
      const { AttachmentBuilder } = require('discord.js');
      const attachment = new AttachmentBuilder(cardBuffer, { name: 'welcome.png' });
      sendPayload.files = [attachment];
      replyFiles.push(attachment);
    }

    let targetChannel = null;
    if (channelId) {
      targetChannel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    }

    if (targetChannel) {
      await targetChannel.send(sendPayload);
      return interaction.editReply({
        content: `✅ Test-Willkommenskarte wurde in <#${channelId}> gesendet.`,
      });
    } else {
      return interaction.editReply({
        content: `ℹ️ Kein Willkommenskanal konfiguriert. Hier ist eine Vorschau:\n**Text:** ${messageText}`,
        files: replyFiles,
      });
    }
  } catch (err) {
    console.error('/config welcome test error:', err);
    return interaction.editReply({
      content: '❌ Fehler bei der Generierung der Test-Willkommenskarte: ' + err.message,
    });
  }
}

async function handleWelcomeSetJoinRole(interaction) {
  const role = interaction.options.getRole('role');
  const pool = getPool();
  const config = require('../config');

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

  const botMember = interaction.guild.members.me;
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return interaction.reply({
      content: '❌ Mir fehlt die Permission "Rollen verwalten" auf diesem Server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (role.position >= botMember.roles.highest.position) {
    return interaction.reply({
      content: `❌ Die Rolle <@&${role.id}> steht in der Hierarchie über oder auf gleicher Höhe wie meine höchste Rolle. Ich kann diese Rolle nicht zuweisen.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [interaction.guildId]);
    await config.setJoinRoleId(interaction.guildId, role.id);
  } catch (err) {
    console.error('/config welcome set-join-role DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: `✅ Neue Mitglieder erhalten beim Beitritt nun automatisch die Rolle <@&${role.id}>.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleWelcomeUnsetJoinRole(interaction) {
  const pool = getPool();

  try {
    await pool.execute(
      'UPDATE guilds SET join_role_id = NULL, join_role_ids = NULL WHERE guild_id = ?',
      [interaction.guildId]
    );
    invalidateGuildRowCache(interaction.guildId);
  } catch (err) {
    console.error('/config welcome unset-join-role DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: '✅ Die automatische Rollenvergabe beim Beitritt wurde vollständig zurückgesetzt.',
    flags: MessageFlags.Ephemeral,
  });
}

async function handleLeaveSet(interaction) {
  const enabled = interaction.options.getBoolean('enabled');
  const channel = interaction.options.getChannel('channel');
  const message = interaction.options.getString('message');
  const background = interaction.options.getString('background');
  const banner = interaction.options.getBoolean('banner');
  const bannertext = interaction.options.getString('bannertext');
  const accent = interaction.options.getString('accent');
  const textcolor = interaction.options.getString('textcolor');

  if (enabled === null && channel === null && message === null && background === null && banner === null && bannertext === null && accent === null && textcolor === null) {
    return interaction.reply({
      content: '❌ Bitte gib mindestens eine Option an, die du konfigurieren möchtest.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Validate hex colors
  const HEX_COLOR_REGEX = /^#[0-9A-F]{6}$/i;
  if (accent && !HEX_COLOR_REGEX.test(accent)) {
    return interaction.reply({
      content: '❌ Die Akzentfarbe muss ein gültiger Hex-Code sein (z.B. `#e74c3c`).',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (textcolor && !HEX_COLOR_REGEX.test(textcolor)) {
    return interaction.reply({
      content: '❌ Die Textfarbe muss ein gültiger Hex-Code sein (z.B. `#e74c3c`).',
      flags: MessageFlags.Ephemeral,
    });
  }

  const pool = getPool();
  try {
    await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [interaction.guildId]);
  } catch (err) {
    console.error('/config leave set DB error (init):', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const config = require('../config');
  const updates = [];

  try {
    if (enabled !== null) {
      await config.setLeaveEnabled(interaction.guildId, enabled);
      updates.push(`Aktiviert: **${enabled ? 'Ja' : 'Nein'}**`);
    }
    if (channel !== null) {
      await config.setLeaveChannelId(interaction.guildId, channel.id);
      updates.push(`Kanal: <#${channel.id}>`);
    }
    if (message !== null) {
      await config.setLeaveMessage(interaction.guildId, message);
      updates.push(`Nachricht: *${message}*`);
    }
    if (background !== null) {
      const cleanBg = background.trim() === 'none' || background.trim() === '' ? null : background;
      await config.setLeaveBgUrl(interaction.guildId, cleanBg);
      updates.push(`Hintergrund: ${cleanBg ? `[Link](${cleanBg})` : 'Standard-Verlauf'}`);
    }
    if (banner !== null) {
      await config.setLeaveBannerEnabled(interaction.guildId, banner);
      updates.push(`Banner mitsenden: **${banner ? 'Ja' : 'Nein'}**`);
    }
    if (bannertext !== null) {
      await config.setLeaveBannerText(interaction.guildId, bannertext);
      updates.push(`Banner-Text: *${bannertext}*`);
    }
    if (accent !== null) {
      await config.setLeaveAccentColor(interaction.guildId, accent);
      updates.push(`Akzentfarbe: \`${accent}\``);
    }
    if (textcolor !== null) {
      await config.setLeaveTextColor(interaction.guildId, textcolor);
      updates.push(`Textfarbe: \`${textcolor}\``);
    }
  } catch (err) {
    console.error('/config leave set DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: `✅ **Leave-System konfiguriert:**\n${updates.map((u) => `• ${u}`).join('\n')}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleLeaveTest(interaction) {
  const config = require('../config');

  try {
    const channelId = await config.getLeaveChannelId(interaction.guildId);
    const leaveMessageTemplate = await config.getLeaveMessage(interaction.guildId);
    const bgUrl = await config.getLeaveBgUrl(interaction.guildId);
    const bannerEnabled = await config.isLeaveBannerEnabled(interaction.guildId);

    const { formatWelcomeMessage } = require('../welcomeCard');
    const messageText = await formatWelcomeMessage(leaveMessageTemplate, interaction.member);

    const sendPayload = { content: messageText };
    const replyFiles = [];

    if (bannerEnabled) {
      const { generateCard } = require('../welcomeCard');
      const cardBuffer = await generateCard(interaction.user, interaction.guild, 'leave', bgUrl);
      const { AttachmentBuilder } = require('discord.js');
      const attachment = new AttachmentBuilder(cardBuffer, { name: 'leave.png' });
      sendPayload.files = [attachment];
      replyFiles.push(attachment);
    }

    let targetChannel = null;
    if (channelId) {
      targetChannel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    }

    if (targetChannel) {
      await targetChannel.send(sendPayload);
      return interaction.editReply({
        content: `✅ Test-Leavekarte wurde in <#${channelId}> gesendet.`,
      });
    } else {
      return interaction.editReply({
        content: `ℹ️ Kein Leavekanal konfiguriert. Hier ist eine Vorschau:\n**Text:** ${messageText}`,
        files: replyFiles,
      });
    }
  } catch (err) {
    console.error('/config leave test error:', err);
    return interaction.editReply({
      content: '❌ Fehler bei der Generierung der Test-Leavekarte: ' + err.message,
    });
  }
}

async function handleWelcomeEdit(interaction) {
  const config = require('../config');
  let message, bg, accent, textcolor, bannerText;
  try {
    message = await config.getWelcomeMessage(interaction.guildId);
    bg = await config.getWelcomeBgUrl(interaction.guildId);
    accent = await config.getWelcomeAccentColor(interaction.guildId);
    textcolor = await config.getWelcomeTextColor(interaction.guildId);
    bannerText = await config.getWelcomeBannerText(interaction.guildId);
  } catch (err) {
    console.error('Failed to load welcome info for modal:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral
    });
  }

  const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

  const modal = new ModalBuilder()
    .setCustomId('welcome:config_modal')
    .setTitle('Willkommens-Design');

  const msgInput = new TextInputBuilder()
    .setCustomId('message')
    .setLabel('Willkommens-Text')
    .setPlaceholder('z.B. Willkommen {user} auf {server}!')
    .setStyle(TextInputStyle.Paragraph)
    .setValue(message)
    .setRequired(false)
    .setMaxLength(255);

  const bgInput = new TextInputBuilder()
    .setCustomId('background')
    .setLabel('Hintergrundbild URL ("none" für Standard)')
    .setPlaceholder('https://picsum.photos/800/400')
    .setStyle(TextInputStyle.Short)
    .setValue(bg || '')
    .setRequired(false)
    .setMaxLength(512);

  const accentInput = new TextInputBuilder()
    .setCustomId('accent')
    .setLabel('Akzentfarbe (Glow / Ring) (Hex-Code)')
    .setPlaceholder('#5865f2')
    .setStyle(TextInputStyle.Short)
    .setValue(accent)
    .setRequired(false)
    .setMaxLength(7);

  const textColorInput = new TextInputBuilder()
    .setCustomId('textcolor')
    .setLabel('Textfarbe (Header-Name) (Hex-Code)')
    .setPlaceholder('#7289da')
    .setStyle(TextInputStyle.Short)
    .setValue(textcolor)
    .setRequired(false)
    .setMaxLength(7);

  const bannerTextInput = new TextInputBuilder()
    .setCustomId('bannertext')
    .setLabel('Banner-Text (auf der Grafik)')
    .setPlaceholder('z.B. WILLKOMMEN')
    .setStyle(TextInputStyle.Short)
    .setValue(bannerText)
    .setRequired(false)
    .setMaxLength(64);

  modal.addComponents(
    new ActionRowBuilder().addComponents(msgInput),
    new ActionRowBuilder().addComponents(bgInput),
    new ActionRowBuilder().addComponents(accentInput),
    new ActionRowBuilder().addComponents(textColorInput),
    new ActionRowBuilder().addComponents(bannerTextInput)
  );

  await interaction.showModal(modal);
}

async function handleLeaveEdit(interaction) {
  const config = require('../config');
  let message, bg, accent, textcolor, bannerText;
  try {
    message = await config.getLeaveMessage(interaction.guildId);
    bg = await config.getLeaveBgUrl(interaction.guildId);
    accent = await config.getLeaveAccentColor(interaction.guildId);
    textcolor = await config.getLeaveTextColor(interaction.guildId);
    bannerText = await config.getLeaveBannerText(interaction.guildId);
  } catch (err) {
    console.error('Failed to load leave info for modal:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral
    });
  }

  const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

  const modal = new ModalBuilder()
    .setCustomId('leave:config_modal')
    .setTitle('Leave-Design');

  const msgInput = new TextInputBuilder()
    .setCustomId('message')
    .setLabel('Leave-Text')
    .setPlaceholder('z.B. {user} ist gegangen.')
    .setStyle(TextInputStyle.Paragraph)
    .setValue(message)
    .setRequired(false)
    .setMaxLength(255);

  const bgInput = new TextInputBuilder()
    .setCustomId('background')
    .setLabel('Hintergrundbild URL ("none" für Standard)')
    .setPlaceholder('https://picsum.photos/800/400')
    .setStyle(TextInputStyle.Short)
    .setValue(bg || '')
    .setRequired(false)
    .setMaxLength(512);

  const accentInput = new TextInputBuilder()
    .setCustomId('accent')
    .setLabel('Akzentfarbe (Glow / Ring) (Hex-Code)')
    .setPlaceholder('#e74c3c')
    .setStyle(TextInputStyle.Short)
    .setValue(accent)
    .setRequired(false)
    .setMaxLength(7);

  const textColorInput = new TextInputBuilder()
    .setCustomId('textcolor')
    .setLabel('Textfarbe (Header-Name) (Hex-Code)')
    .setPlaceholder('#e74c3c')
    .setStyle(TextInputStyle.Short)
    .setValue(textcolor)
    .setRequired(false)
    .setMaxLength(7);

  const bannerTextInput = new TextInputBuilder()
    .setCustomId('bannertext')
    .setLabel('Banner-Text (auf der Grafik)')
    .setPlaceholder('z.B. AUF WIEDERSEHEN')
    .setStyle(TextInputStyle.Short)
    .setValue(bannerText)
    .setRequired(false)
    .setMaxLength(64);

  modal.addComponents(
    new ActionRowBuilder().addComponents(msgInput),
    new ActionRowBuilder().addComponents(bgInput),
    new ActionRowBuilder().addComponents(accentInput),
    new ActionRowBuilder().addComponents(textColorInput),
    new ActionRowBuilder().addComponents(bannerTextInput)
  );

  await interaction.showModal(modal);
}

async function handleVoiceSet(interaction) {
  const enabled = interaction.options.getBoolean('enabled');
  const channel = interaction.options.getChannel('channel');
  const message = interaction.options.getString('message');

  if (enabled === null && channel === null && message === null) {
    return interaction.reply({
      content: '❌ Bitte gib mindestens eine Option an, die du konfigurieren möchtest.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const pool = getPool();
  try {
    await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [interaction.guildId]);
  } catch (err) {
    console.error('/config voice set DB error (init):', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const config = require('../config');
  const updates = [];

  try {
    if (enabled !== null) {
      await config.setVoiceRecEnabled(interaction.guildId, enabled);
      updates.push(`Aktiviert: **${enabled ? 'Ja' : 'Nein'}**`);
      if (!enabled) {
        // Deaktivierung greift sofort: Verbindung sofort kappen, statt auf die
        // nächste transkribierte Äußerung in speech.js zu warten (siehe invariant 17).
        getVoiceConnection(interaction.guildId)?.destroy();
      }
    }
    if (channel !== null) {
      await config.setVoiceRecChannelId(interaction.guildId, channel.id);
      updates.push(`Kanal: <#${channel.id}>`);
    }
    if (message !== null) {
      await config.setVoiceRecMessage(interaction.guildId, message);
      updates.push(`Satz: *${message}*`);
    }
  } catch (err) {
    console.error('/config voice set DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: `✅ **Voice-Recognition-System konfiguriert:**\n${updates.map((u) => `• ${u}`).join('\n')}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleLevelPermsSet(interaction) {
  const level = interaction.options.getInteger('level');
  const role = interaction.options.getRole('role') ?? null;
  const guildId = interaction.guildId;
  const pool = getPool();

  try {
    await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [guildId]);
    await pool.execute(
      'UPDATE guilds SET level_supporter_required = ?, candidacy_role_id = ? WHERE guild_id = ?',
      [level, role ? role.id : null, guildId]
    );
    invalidateGuildRowCache(guildId);

    const embed = new EmbedBuilder()
      .setColor('#2ECC71')
      .setTitle('✅ Level-Rechte-Verknüpfung aktualisiert')
      .setDescription(`User erhalten ab **Level ${level}** automatisch Supporter-Rechte in Oreo.`)
      .addFields(
        { name: '📈 Benötigtes Level', value: `Level ${level}`, inline: true },
        { name: '🏅 Rolle bei Level-Up', value: role ? `${role}` : '(Keine Rolle konfiguriert)', inline: true }
      )
      .setFooter({ text: 'Oreo & Ramen Synergy 🐾' })
      .setTimestamp();

    return await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error('[config] Failed to set levelperms:', err);
    return await interaction.reply({ content: '❌ Datenbankfehler beim Speichern.', flags: MessageFlags.Ephemeral });
  }
}

async function handleLevelPermsUnset(interaction) {
  const guildId = interaction.guildId;
  const pool = getPool();

  try {
    await pool.execute(
      'UPDATE guilds SET level_supporter_required = NULL, candidacy_role_id = NULL WHERE guild_id = ?',
      [guildId]
    );
    invalidateGuildRowCache(guildId);

    const embed = new EmbedBuilder()
      .setColor('#E74C3C')
      .setTitle('❌ Level-Rechte-Verknüpfung entfernt')
      .setDescription('Die Level-Rechte-Verknüpfung wurde deaktiviert.')
      .setFooter({ text: 'Oreo & Ramen Synergy 🐾' })
      .setTimestamp();

    return await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error('[config] Failed to unset levelperms:', err);
    return await interaction.reply({ content: '❌ Datenbankfehler beim Speichern.', flags: MessageFlags.Ephemeral });
  }
}

async function handleWelcomeAddJoinRole(interaction) {
  const role = interaction.options.getRole('role');
  const config = require('../config');

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

  const botMember = interaction.guild.members.me;
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return interaction.reply({
      content: '❌ Mir fehlt die Permission "Rollen verwalten" auf diesem Server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (role.position >= botMember.roles.highest.position) {
    return interaction.reply({
      content: `❌ Die Rolle <@&${role.id}> steht in der Hierarchie über oder auf gleicher Höhe wie meine höchste Rolle. Ich kann diese Rolle nicht zuweisen.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    const pool = getPool();
    await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [interaction.guildId]);
    const success = await config.addJoinRoleId(interaction.guildId, role.id);
    if (!success) {
      return interaction.reply({
        content: `⚠️ Rolle <@&${role.id}> ist bereits als automatische Beitrittsrolle konfiguriert.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    console.error('/config welcome add-join-role DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: `✅ Rolle <@&${role.id}> wurde zu den automatischen Beitrittsrollen hinzugefügt.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleWelcomeRemoveJoinRole(interaction) {
  const role = interaction.options.getRole('role');
  const config = require('../config');

  try {
    const success = await config.removeJoinRoleId(interaction.guildId, role.id);
    if (!success) {
      return interaction.reply({
        content: `⚠️ Rolle <@&${role.id}> ist nicht als automatische Beitrittsrolle konfiguriert.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    console.error('/config welcome remove-join-role DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: `✅ Rolle <@&${role.id}> wurde aus den automatischen Beitrittsrollen entfernt.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSecurityAddVerifiedRole(interaction) {
  const role = interaction.options.getRole('role');
  const config = require('../config');

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

  const botMember = interaction.guild.members.me;
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return interaction.reply({
      content: '❌ Mir fehlt die Permission "Rollen verwalten" auf diesem Server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (role.position >= botMember.roles.highest.position) {
    return interaction.reply({
      content: `❌ Die Rolle <@&${role.id}> steht in der Hierarchie über oder auf gleicher Höhe wie meine höchste Rolle. Ich kann diese Rolle nicht zuweisen.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    const pool = getPool();
    await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [interaction.guildId]);
    const success = await config.addVerifiedRoleId(interaction.guildId, role.id);
    if (!success) {
      return interaction.reply({
        content: `⚠️ Rolle <@&${role.id}> ist bereits als Verifizierungs-Rolle konfiguriert.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    console.error('/config security add-verified-role DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: `✅ Rolle <@&${role.id}> wurde zu den Rollen hinzugefügt, die nach erfolgreicher Verifizierung vergeben werden.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSecurityRemoveVerifiedRole(interaction) {
  const role = interaction.options.getRole('role');
  const config = require('../config');

  try {
    const success = await config.removeVerifiedRoleId(interaction.guildId, role.id);
    if (!success) {
      return interaction.reply({
        content: `⚠️ Rolle <@&${role.id}> ist nicht als Verifizierungs-Rolle konfiguriert.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    console.error('/config security remove-verified-role DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: `✅ Rolle <@&${role.id}> wurde aus den verifizierten Rollen entfernt.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSecurityAddUnverifiedRole(interaction) {
  const role = interaction.options.getRole('role');
  const config = require('../config');

  if (role.id === interaction.guildId) {
    return interaction.reply({
      content: 'Die @everyone-Rolle ist ungültig.',
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    const pool = getPool();
    await pool.execute('INSERT IGNORE INTO guilds (guild_id) VALUES (?)', [interaction.guildId]);
    const success = await config.addUnverifiedRoleId(interaction.guildId, role.id);
    if (!success) {
      return interaction.reply({
        content: `⚠️ Rolle <@&${role.id}> ist bereits als zu entfernende Rolle konfiguriert.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    console.error('/config security add-unverified-role DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: `✅ Rolle <@&${role.id}> wurde zu den Rollen hinzugefügt, die nach erfolgreicher Verifizierung entfernt werden.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSecurityRemoveUnverifiedRole(interaction) {
  const role = interaction.options.getRole('role');
  const config = require('../config');

  try {
    const success = await config.removeUnverifiedRoleId(interaction.guildId, role.id);
    if (!success) {
      return interaction.reply({
        content: `⚠️ Rolle <@&${role.id}> ist nicht als zu entfernende Rolle konfiguriert.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    console.error('/config security remove-unverified-role DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: `✅ Rolle <@&${role.id}> wurde aus den zu entfernenden unverifizierten Rollen entfernt.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSecurityUnsetVerifiedRoles(interaction) {
  const pool = getPool();

  try {
    await pool.execute(
      'UPDATE guilds SET verified_role_id = NULL, verified_role_ids = NULL WHERE guild_id = ?',
      [interaction.guildId]
    );
    invalidateGuildRowCache(interaction.guildId);
  } catch (err) {
    console.error('/config security unset-verified-roles DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: '✅ Alle verifizierten Rollen wurden erfolgreich zurückgesetzt.',
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSecurityUnsetUnverifiedRoles(interaction) {
  const pool = getPool();

  try {
    await pool.execute(
      'UPDATE guilds SET unverified_role_ids = NULL WHERE guild_id = ?',
      [interaction.guildId]
    );
    invalidateGuildRowCache(interaction.guildId);
  } catch (err) {
    console.error('/config security unset-unverified-roles DB error:', err);
    return interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: '✅ Alle zu entfernenden unverified Rollen wurden erfolgreich zurückgesetzt.',
    flags: MessageFlags.Ephemeral,
  });
}

