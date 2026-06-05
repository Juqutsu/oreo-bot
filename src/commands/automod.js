const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');

const automod = require('../automod');
const perms   = require('../perms');

const {
  FILTER_KEYS,
  PRESET_BITS,
  PRESET_FLAGS_ALL,
  MENTION_THRESHOLD_DEFAULT,
  TRIGGER_NAMES,
  AutoModError,
} = automod;

// ---- Slash builder ----

const data = new SlashCommandBuilder()
  .setName('automod')
  .setDescription('Configure Oreo AutoMod (admin-only).')
  .setDMPermission(false)
  .addSubcommand((sc) => sc
    .setName('status')
    .setDescription('Show the state of all AutoMod filters.'))
  .addSubcommand((sc) => sc
    .setName('enable')
    .setDescription('Provision and enable a filter.')
    .addStringOption((o) => o
      .setName('filter').setDescription('Which filter').setRequired(true)
      .addChoices(...FILTER_KEYS.map((k) => ({ name: k, value: k })))))
  .addSubcommand((sc) => sc
    .setName('disable')
    .setDescription('Delete the Discord rule and disable the filter.')
    .addStringOption((o) => o
      .setName('filter').setDescription('Which filter').setRequired(true)
      .addChoices(...FILTER_KEYS.map((k) => ({ name: k, value: k })))))
  .addSubcommand((sc) => sc
    .setName('threshold')
    .setDescription('Set the mention-spam threshold (1–50).')
    .addIntegerOption((o) => o
      .setName('count').setDescription('Mentions per message').setRequired(true)
      .setMinValue(1).setMaxValue(50)))
  .addSubcommand((sc) => sc
    .setName('preset')
    .setDescription('Toggle a Discord KeywordPreset bucket.')
    .addStringOption((o) => o
      .setName('bucket').setDescription('Which bucket').setRequired(true)
      .addChoices(
        { name: 'profanity',      value: 'profanity' },
        { name: 'sexual_content', value: 'sexual_content' },
        { name: 'slurs',          value: 'slurs' },
      ))
    .addBooleanOption((o) => o
      .setName('on').setDescription('Enable this bucket?').setRequired(true)))
  .addSubcommandGroup((g) => g
    .setName('wordlist').setDescription('Custom wordlist CRUD.')
    .addSubcommand((sc) => sc
      .setName('add').setDescription('Add a word.')
      .addStringOption((o) => o
        .setName('word').setDescription('Word (≤60 chars)').setRequired(true)))
    .addSubcommand((sc) => sc
      .setName('remove').setDescription('Remove a word.')
      .addStringOption((o) => o
        .setName('word').setDescription('Word to remove').setRequired(true).setAutocomplete(true)))
    .addSubcommand((sc) => sc
      .setName('list').setDescription('List all words.')))
  .addSubcommandGroup((g) => g
    .setName('exempt').setDescription('Extra exempt roles/channels CRUD.')
    .addSubcommand((sc) => sc
      .setName('role-add').setDescription('Add an extra exempt role.')
      .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand((sc) => sc
      .setName('role-remove').setDescription('Remove an extra exempt role.')
      .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand((sc) => sc
      .setName('channel-add').setDescription('Add an exempt channel.')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true)))
    .addSubcommand((sc) => sc
      .setName('channel-remove').setDescription('Remove an exempt channel.')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true)))
    .addSubcommand((sc) => sc
      .setName('list').setDescription('List effective exempts (auto-baked + extra).')))
  .addSubcommand((sc) => sc
    .setName('resync')
    .setDescription('Re-push current exempt lists to every enabled rule.'));

// ---- Tier gate ----

async function gateOrAbort(interaction) {
  const allowed = await perms.requireTier(interaction, 'owner');
  return allowed;
}

// ---- Autocomplete handler (for wordlist remove) ----

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (interaction.options.getSubcommandGroup(false) !== 'wordlist') return interaction.respond([]);
  if (interaction.options.getSubcommand(false)     !== 'remove')    return interaction.respond([]);
  if (focused.name !== 'word')                                       return interaction.respond([]);

  const words = await automod.getWordlist(interaction.guildId);
  const needle = focused.value.toLowerCase();
  const choices = words
    .filter((w) => w.includes(needle))
    .slice(0, 25)
    .map((w) => ({ name: w, value: w }));
  await interaction.respond(choices);
}

// ---- Error mapping (AutoModError → German user-facing string) ----

function explain(err) {
  if (!(err instanceof AutoModError)) return null;
  switch (err.code) {
    case 'LIMIT_ROLES_20':    return `❌ ${err.detail} Rollen würden exempt sein, Discord erlaubt max 20. Entferne 1+ Rollen mit \`/automod exempt role-remove\`.`;
    case 'LIMIT_CHANNELS_50': return `❌ ${err.detail} Channels exempt, Discord erlaubt max 50. Entferne welche mit \`/automod exempt channel-remove\`.`;
    case 'WORDLIST_FULL':     return `❌ Limit von ${err.detail} Wörtern erreicht. Entferne erst ein Wort.`;
    case 'WORDLIST_EMPTY':    return '❌ `custom_wordlist` ist leer. Erst Wörter mit `/automod wordlist add` hinzufügen.';
    case 'WORD_TOO_LONG':     return `❌ Wort ist ${err.detail} Zeichen, max 60.`;
    case 'WORD_EMPTY':        return '❌ Leeres Wort nicht erlaubt.';
    case 'WORD_DUPLICATE':    return `❌ Wort "${err.detail}" existiert bereits.`;
    case 'WORD_NOT_FOUND':    return `❌ Wort "${err.detail}" nicht in der Wordlist.`;
    case 'EXEMPT_DUPLICATE':  return `❌ Eintrag existiert bereits (${err.detail}).`;
    case 'EXEMPT_NOT_FOUND':  return `❌ Eintrag nicht gefunden (${err.detail}).`;
    case 'UNKNOWN_FILTER':    return `❌ Unbekannter Filter: ${err.detail}.`;
    default:                  return `❌ AutoMod-Fehler: ${err.code}${err.detail !== null ? ` (${err.detail})` : ''}`;
  }
}

function explainDiscord(err) {
  if (err?.code === 50013) return '❌ Mir fehlt die Berechtigung *Manage Guild*. Gib mir die Rolle und versuch\'s nochmal.';
  if (err?.code === 429 || err?.httpStatus === 429) return '⏳ Discord limitiert gerade AutoMod-Edits, bitte ~30 Sek warten.';
  return null;
}

async function ephemeralReply(interaction, content) {
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ content });
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}

// ---- Subcommand: status ----

async function doStatus(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const rows = await automod.getAllRuleStates(interaction.guildId);
  const byKey = new Map(rows.map((r) => [r.filter_key, r]));
  const lines = ['```',
    'Filter                   Status   Discord-Rule-ID       Extra',
    '─────────────────────────────────────────────────────────────'];

  for (const key of FILTER_KEYS) {
    const r = byKey.get(key);
    const label   = (TRIGGER_NAMES[key] ?? key).padEnd(24);
    const status  = r?.enabled ? '✅ on '  : '❌ off';
    const ruleId  = (r?.discord_rule_id ? String(r.discord_rule_id) : '—').padEnd(20);
    let extra = '—';
    if (key === 'mention_spam' && r?.threshold != null) {
      extra = `threshold: ${r.threshold}`;
    } else if (key === 'invite_links' && r?.enabled) {
      extra = `${automod.INVITE_REGEX.length} regex patterns`;
    } else if (key === 'keyword_preset' && r?.preset_flags != null) {
      const buckets = [];
      if (r.preset_flags & PRESET_BITS.profanity)      buckets.push('Profanity');
      if (r.preset_flags & PRESET_BITS.sexual_content) buckets.push('SexualContent');
      if (r.preset_flags & PRESET_BITS.slurs)          buckets.push('Slurs');
      extra = buckets.join(', ') || 'none';
    } else if (key === 'custom_wordlist') {
      const n = await automod.countWords(interaction.guildId);
      extra = `${n} words`;
    }
    lines.push(`${label} ${status}   ${ruleId} ${extra}`);
  }
  lines.push('```');
  await interaction.editReply({ content: lines.join('\n') });
}

// ---- Subcommand: enable ----

async function doEnable(interaction) {
  const filterKey = interaction.options.getString('filter', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const existing = await automod.getRuleState(interaction.guildId, filterKey);

  // Default seeding for first enable.
  const defaults = {};
  if (filterKey === 'mention_spam' && existing?.threshold == null) {
    defaults.threshold = MENTION_THRESHOLD_DEFAULT;
  }
  if (filterKey === 'keyword_preset' && existing?.preset_flags == null) {
    defaults.preset_flags = PRESET_FLAGS_ALL;
  }
  if (Object.keys(defaults).length > 0) {
    await automod.upsertRuleState(interaction.guildId, filterKey, defaults);
  }

  // Idempotency: re-use existing rule if Discord still has it.
  if (existing?.discord_rule_id) {
    const fetched = await automod.fetchDiscordRule(interaction.guild, existing.discord_rule_id);
    if (fetched) {
      const exempts = await automod.buildExempts(interaction.guildId);
      await automod.patchDiscordRule(interaction.guild, existing.discord_rule_id, {
        enabled:        true,
        exemptRoles:    exempts.exemptRoles,
        exemptChannels: exempts.exemptChannels,
      });
      await automod.upsertRuleState(interaction.guildId, filterKey, { enabled: 1 });
      return interaction.editReply(`✅ \`${filterKey}\` war bereits provisioned (Rule ${existing.discord_rule_id}) — Status auf an gesetzt, exempts gefrischt.`);
    }
    // 404: zombie state, nuke it and re-create
    await automod.upsertRuleState(interaction.guildId, filterKey, { discord_rule_id: null, enabled: 0 });
  }

  const rule = await automod.createDiscordRule(
    interaction.guild,
    filterKey,
    interaction.user.globalName ?? interaction.user.username,
  );
  await automod.upsertRuleState(interaction.guildId, filterKey, {
    discord_rule_id: rule.id,
    enabled: 1,
  });
  await interaction.editReply(`✅ \`${filterKey}\` enabled (Discord-Rule-ID \`${rule.id}\`).`);
}

// ---- Subcommand: disable ----

async function doDisable(interaction) {
  const filterKey = interaction.options.getString('filter', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const state = await automod.getRuleState(interaction.guildId, filterKey);
  if (!state || !state.enabled) {
    return interaction.editReply(`ℹ️ \`${filterKey}\` ist bereits disabled.`);
  }
  if (state.discord_rule_id) {
    const modTag = interaction.user.globalName ?? interaction.user.username;
    await automod.deleteDiscordRule(interaction.guild, state.discord_rule_id, `Oreo /automod disable by ${modTag}`);
  }
  await automod.upsertRuleState(interaction.guildId, filterKey, { discord_rule_id: null, enabled: 0 });
  await interaction.editReply(`✅ \`${filterKey}\` disabled.`);
}

// ---- Subcommand: threshold ----

async function doThreshold(interaction) {
  const count = interaction.options.getInteger('count', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  await automod.upsertRuleState(interaction.guildId, 'mention_spam', { threshold: count });

  const state = await automod.getRuleState(interaction.guildId, 'mention_spam');
  if (state?.enabled && state?.discord_rule_id) {
    const patched = await automod.patchDiscordRule(interaction.guild, state.discord_rule_id, {
      triggerMetadata: { mentionTotalLimit: count, mentionRaidProtectionEnabled: true },
    });
    if (!patched) {
      await automod.upsertRuleState(interaction.guildId, 'mention_spam', { discord_rule_id: null, enabled: 0 });
      return interaction.editReply(`⚠️ Threshold gespeichert (${count}), aber die Discord-Rule existierte nicht mehr. State zurückgesetzt — neu enablen mit \`/automod enable mention_spam\`.`);
    }
  }
  await interaction.editReply(`✅ Mention-Threshold = ${count}.`);
}

// ---- Subcommand: preset ----

async function doPreset(interaction) {
  const bucket = interaction.options.getString('bucket', true);
  const on     = interaction.options.getBoolean('on',     true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const state = await automod.getRuleState(interaction.guildId, 'keyword_preset');
  const current = state?.preset_flags ?? PRESET_FLAGS_ALL;
  const bit = PRESET_BITS[bucket];
  const next = on ? (current | bit) : (current & ~bit);

  if (next === 0) {
    return interaction.editReply('❌ Mindestens 1 Bucket muss aktiv bleiben. Nutze `/automod disable keyword_preset` um den Filter ganz auszuschalten.');
  }

  await automod.upsertRuleState(interaction.guildId, 'keyword_preset', { preset_flags: next });

  if (state?.enabled && state?.discord_rule_id) {
    const patched = await automod.patchDiscordRule(interaction.guild, state.discord_rule_id, {
      triggerMetadata: { presets: automod.unpackPresets(next), allowList: [] },
    });
    if (!patched) {
      await automod.upsertRuleState(interaction.guildId, 'keyword_preset', { discord_rule_id: null, enabled: 0 });
      return interaction.editReply(`⚠️ Preset-Flags gespeichert, aber die Discord-Rule existierte nicht mehr. State zurückgesetzt.`);
    }
  }
  await interaction.editReply(`✅ Preset \`${bucket}\` → ${on ? 'on' : 'off'}.`);
}

// ---- Subcommand-group: wordlist ----

async function doWordlistAdd(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const word = interaction.options.getString('word', true);
  const stored = await automod.addWord(interaction.guildId, word, interaction.user.id);

  const state = await automod.getRuleState(interaction.guildId, 'custom_wordlist');
  if (state?.enabled && state?.discord_rule_id) {
    const fresh = await automod.getWordlist(interaction.guildId);
    const patched = await automod.patchDiscordRule(interaction.guild, state.discord_rule_id, {
      triggerMetadata: { keywordFilter: fresh, regexPatterns: [], allowList: [] },
    });
    if (!patched) {
      await automod.upsertRuleState(interaction.guildId, 'custom_wordlist', { discord_rule_id: null, enabled: 0 });
      return interaction.editReply(`✅ "${stored}" gespeichert, aber Discord-Rule existierte nicht mehr — state zurückgesetzt.`);
    }
  }
  await interaction.editReply(`✅ "${stored}" hinzugefügt.`);
}

async function doWordlistRemove(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const word = interaction.options.getString('word', true);
  const removed = await automod.removeWord(interaction.guildId, word);

  const state = await automod.getRuleState(interaction.guildId, 'custom_wordlist');
  if (state?.enabled && state?.discord_rule_id) {
    const fresh = await automod.getWordlist(interaction.guildId);
    if (fresh.length === 0) {
      // Disable filter rather than push an empty keyword rule (Discord rejects).
      await automod.deleteDiscordRule(interaction.guild, state.discord_rule_id, 'Wordlist leer');
      await automod.upsertRuleState(interaction.guildId, 'custom_wordlist', { discord_rule_id: null, enabled: 0 });
      return interaction.editReply(`✅ "${removed}" entfernt. Wordlist ist jetzt leer → Filter disabled.`);
    }
    const patched = await automod.patchDiscordRule(interaction.guild, state.discord_rule_id, {
      triggerMetadata: { keywordFilter: fresh, regexPatterns: [], allowList: [] },
    });
    if (!patched) {
      await automod.upsertRuleState(interaction.guildId, 'custom_wordlist', { discord_rule_id: null, enabled: 0 });
      return interaction.editReply(`✅ "${removed}" entfernt, aber Discord-Rule existierte nicht mehr — state zurückgesetzt.`);
    }
  }
  await interaction.editReply(`✅ "${removed}" entfernt.`);
}

async function doWordlistList(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const words = await automod.getWordlist(interaction.guildId);
  if (words.length === 0) return interaction.editReply('*(Wordlist leer.)*');
  const chunks = [];
  let current = '```\n';
  for (const w of words) {
    if (current.length + w.length + 2 > 1900) { current += '```'; chunks.push(current); current = '```\n'; }
    current += w + '\n';
  }
  current += '```';
  chunks.push(current);
  await interaction.editReply(`**Wordlist (${words.length}):**\n${chunks[0]}`);
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp({ content: chunks[i], flags: MessageFlags.Ephemeral });
  }
}

// ---- Subcommand-group: exempt ----

async function pushExemptsToAllEnabled(interaction) {
  const enabled = await automod.getEnabledRuleIds(interaction.guildId);
  if (enabled.length === 0) return { patched: 0, dropped: 0 };
  const exempts = await automod.buildExempts(interaction.guildId);

  let patched = 0, dropped = 0;
  for (const row of enabled) {
    const ok = await automod.patchDiscordRule(interaction.guild, row.discord_rule_id, {
      exemptRoles:    exempts.exemptRoles,
      exemptChannels: exempts.exemptChannels,
    });
    if (ok) {
      patched++;
    } else {
      await automod.upsertRuleState(interaction.guildId, row.filter_key, {
        discord_rule_id: null, enabled: 0,
      });
      dropped++;
    }
  }
  return { patched, dropped };
}

async function doExemptAdd(interaction, targetType) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const option = targetType === 'role'
    ? interaction.options.getRole('role',    true)
    : interaction.options.getChannel('channel', true);
  await automod.addExemption(interaction.guildId, targetType, option.id);
  const { patched, dropped } = await pushExemptsToAllEnabled(interaction);
  const tail = patched
    ? ` Re-synced ${patched} rule(s)${dropped ? `, ${dropped} zombie rule(s) cleared` : ''}.`
    : '';
  await interaction.editReply(`✅ ${targetType === 'role' ? 'Rolle' : 'Channel'} <${targetType === 'role' ? '@&' : '#'}${option.id}> exempt.${tail}`);
}

async function doExemptRemove(interaction, targetType) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const option = targetType === 'role'
    ? interaction.options.getRole('role',    true)
    : interaction.options.getChannel('channel', true);
  await automod.removeExemption(interaction.guildId, targetType, option.id);
  const { patched, dropped } = await pushExemptsToAllEnabled(interaction);
  const tail = patched
    ? ` Re-synced ${patched} rule(s)${dropped ? `, ${dropped} zombie rule(s) cleared` : ''}.`
    : '';
  await interaction.editReply(`✅ Exemption entfernt.${tail}`);
}

async function doExemptList(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const tierRoles  = await automod.getTierRoleIds(interaction.guildId, ['owner', 'moderator']);
  const extraRoles = await automod.getExtraExemptIds(interaction.guildId, 'role');
  const extraChans = await automod.getExtraExemptIds(interaction.guildId, 'channel');
  const lines = ['**Effective exempt list:**',
    `Auto-baked owner/moderator roles: ${tierRoles.length ? tierRoles.map((id) => `<@&${id}>`).join(' ') : '—'}`,
    `Extra exempt roles:               ${extraRoles.length ? extraRoles.map((id) => `<@&${id}>`).join(' ') : '—'}`,
    `Extra exempt channels:            ${extraChans.length ? extraChans.map((id) => `<#${id}>`).join(' ') : '—'}`];
  await interaction.editReply(lines.join('\n'));
}

// ---- Subcommand: resync ----

async function doResync(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { patched, dropped } = await pushExemptsToAllEnabled(interaction);
  if (patched === 0 && dropped === 0) {
    return interaction.editReply('ℹ️ Keine enabled Filter zu syncen.');
  }
  await interaction.editReply(`✅ ${patched} rule(s) re-synced${dropped ? `, ${dropped} zombie rule(s) cleared` : ''}.`);
}

// ---- Dispatcher ----

async function execute(interaction) {
  if (!(await gateOrAbort(interaction))) return;

  const group = interaction.options.getSubcommandGroup(false);
  const sub   = interaction.options.getSubcommand(true);

  try {
    if (!group) {
      if (sub === 'status')    return await doStatus(interaction);
      if (sub === 'enable')    return await doEnable(interaction);
      if (sub === 'disable')   return await doDisable(interaction);
      if (sub === 'threshold') return await doThreshold(interaction);
      if (sub === 'preset')    return await doPreset(interaction);
      if (sub === 'resync')    return await doResync(interaction);
    } else if (group === 'wordlist') {
      if (sub === 'add')    return await doWordlistAdd(interaction);
      if (sub === 'remove') return await doWordlistRemove(interaction);
      if (sub === 'list')   return await doWordlistList(interaction);
    } else if (group === 'exempt') {
      if (sub === 'role-add')       return await doExemptAdd(interaction,    'role');
      if (sub === 'role-remove')    return await doExemptRemove(interaction, 'role');
      if (sub === 'channel-add')    return await doExemptAdd(interaction,    'channel');
      if (sub === 'channel-remove') return await doExemptRemove(interaction, 'channel');
      if (sub === 'list')           return await doExemptList(interaction);
    }
    await ephemeralReply(interaction, `❌ Unknown subcommand: ${group ? `${group} ` : ''}${sub}`);
  } catch (err) {
    const a = explain(err);
    if (a) return ephemeralReply(interaction, a);
    const d = explainDiscord(err);
    if (d) return ephemeralReply(interaction, d);
    console.error('[automod command] unexpected error:', err);
    return ephemeralReply(interaction, '❌ Unerwarteter Fehler. Logs prüfen.');
  }
}

module.exports = { data, execute, autocomplete };
