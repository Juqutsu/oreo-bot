const { Client, Collection, Events, GatewayIntentBits, MessageFlags, Partials } = require('discord.js');
const { loadCommands } = require('./src/loadCommands');
const { loadEvents }   = require('./src/loadEvents');
const { deployCommands } = require('./src/deployCommands');
const { ping: pingDb } = require('./src/db');
const { ensureSchema } = require('./src/schema');
const perms = require('./src/perms');
const reportInteractions = require('./src/interactions/report');
const announcementInteractions = require('./src/interactions/announcement');
const captchaInteractions = require('./src/interactions/captcha');
const welcomeInteractions = require('./src/interactions/welcome');


const {
  DISCORD_TOKEN, CLIENT_ID, GUILD_ID,
  MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE,
} = process.env;

const required = {
  DISCORD_TOKEN, CLIENT_ID, GUILD_ID,
  MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE,
};
for (const [key, value] of Object.entries(required)) {
  if (!value) {
    console.error(`Missing ${key} in environment.`);
    process.exit(1);
  }
}

process.on('unhandledRejection', (err) => {
  console.error('[process] Unhandled promise rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught exception — exiting:', err);
  process.exit(1);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.AutoModerationConfiguration,
    GatewayIntentBits.AutoModerationExecution,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Message, Partials.GuildMember, Partials.User],
});

const { addSpeechEvent } = require('discord-speech-recognition');
addSpeechEvent(client, {
  lang: 'de-DE',
});

client.commands = new Collection(loadCommands());
const _evtCount = loadEvents(client);
console.log(`[startup] Registered ${_evtCount} event handler(s)`);

const { startBackgroundTasks } = require('./src/background');

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag} (${client.commands.size} command(s) loaded)`);
  
  try {
    const invitesTracker = require('./src/invites');
    for (const guild of c.guilds.cache.values()) {
      await invitesTracker.cacheGuildInvites(guild);
    }
    console.log(`[startup] Cached invites for ${c.guilds.cache.size} guild(s)`);
  } catch (err) {
    console.error('Failed to cache invites on startup:', err);
  }

  startBackgroundTasks(client);
});

client.on(Events.InteractionCreate, async (interaction) => {
  // Monkey-patch interaction.reply to automatically use editReply if deferred or replied
  if (interaction.reply && !interaction.reply.patched) {
    const originalReply = interaction.reply;
    interaction.reply = async function (options) {
      if (this.deferred || this.replied) {
        return this.editReply(options);
      }
      return originalReply.call(this, options);
    };
    interaction.reply.patched = true;
  }

  // Slash-command path (including autocomplete) — existing behavior, unchanged
  if (interaction.isChatInputCommand() || interaction.isAutocomplete()) {
    if (!interaction.guildId) {
      if (interaction.isChatInputCommand()) {
        await interaction.reply({
          content: '❌ Befehle können nur auf einem Discord-Server verwendet werden.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
      return;
    }

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    if (interaction.isAutocomplete()) {
      if (typeof command.autocomplete !== 'function') return;
      if (command.requiredTier) {
        const allowed = await perms
          .hasTier(interaction.guildId, interaction.member, command.requiredTier)
          .catch(() => false);
        if (!allowed) {
          await interaction.respond([]).catch(() => {});
          return;
        }
      }
      try {
        await command.autocomplete(interaction);
      } catch (err) {
        console.error(`Autocomplete für "${interaction.commandName}" fehlgeschlagen:`, err);
      }
      return;
    }

    // Auto-defer all slash commands except announcement and config edit subcommands (which need to show modal first)
    const isConfigEdit = interaction.commandName === 'config' && interaction.options.getSubcommand(false) === 'edit';
    if (interaction.isChatInputCommand() && interaction.commandName !== 'announcement' && !isConfigEdit) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    }

    if (command.requiredTier) {
      let allowed;
      try {
        allowed = await perms.requireTier(interaction, command.requiredTier);
      } catch (err) {
        console.error(`Tier-Check für "${interaction.commandName}" fehlgeschlagen:`, err);
        const reply = { content: 'Beim Ausführen des Commands ist etwas schiefgegangen.', flags: MessageFlags.Ephemeral };
        if (interaction.deferred && !interaction.replied) {
          await interaction.editReply(reply).catch(() => {});
        } else if (interaction.replied) {
          await interaction.followUp(reply).catch(() => {});
        } else {
          await interaction.reply(reply).catch(() => {});
        }
        return;
      }
      if (!allowed) {
        console.info(`[perms] ${interaction.user.tag} blocked from /${interaction.commandName} (tier required: ${command.requiredTier})`);
        return;
      }
    }

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(`Command "${interaction.commandName}" failed:`, err);
      const reply = { content: 'Beim Ausführen des Commands ist etwas schiefgegangen.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred && !interaction.replied) {
        await interaction.editReply(reply).catch(() => {});
      } else if (interaction.replied) {
        await interaction.followUp(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
    return;
  }

  // Component path (button / string-select / modal-submit) — new
  if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
    try {
      const handled = await reportInteractions.dispatch(interaction)
                   || await announcementInteractions.dispatch(interaction)
                   || await captchaInteractions.dispatch(interaction)
                   || await welcomeInteractions.dispatch(interaction);
      if (!handled) {
        await interaction.reply({ content: 'Unbekannte Interaktion.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      // Future feature dispatchers (escalation, automod) chain here:
      // const handled = await reportInteractions.dispatch(interaction) || await escalationInteractions.dispatch(interaction);
    } catch (e) {
      console.error('[interactions] dispatch error', e);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Fehler bei der Verarbeitung.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
    return;
  }

  console.warn('[interactions] unrecognised interaction type', interaction.type);
});

(async () => {
  try {
    await pingDb();
    console.log('MySQL reachable.');
  } catch (err) {
    console.error('Failed to reach MySQL:', err.message);
    process.exit(1);
  }

  try {
    await ensureSchema();
    console.log('Schema sichergestellt.');
  } catch (err) {
    console.error('Schema-Setup fehlgeschlagen:', err.message);
    process.exit(1);
  }

  await deployCommands({
    token: DISCORD_TOKEN,
    clientId: CLIENT_ID,
    guildId: GUILD_ID,
    commands: client.commands,
  });
  await client.login(DISCORD_TOKEN);
})();
