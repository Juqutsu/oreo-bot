const { Client, Collection, Events, GatewayIntentBits, MessageFlags } = require('discord.js');
const { loadCommands } = require('./src/loadCommands');
const { deployCommands } = require('./src/deployCommands');
const { ping: pingDb } = require('./src/db');
const { ensureSchema } = require('./src/schema');
const perms = require('./src/perms');

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

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection(loadCommands());

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag} (${client.commands.size} command(s) loaded)`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  if (interaction.isAutocomplete()) {
    if (typeof command.autocomplete !== 'function') return;
    try {
      await command.autocomplete(interaction);
    } catch (err) {
      console.error(`Autocomplete für "${interaction.commandName}" fehlgeschlagen:`, err);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (command.requiredTier) {
    let allowed;
    try {
      allowed = await perms.requireTier(interaction, command.requiredTier);
    } catch (err) {
      console.error(`Tier-Check für "${interaction.commandName}" fehlgeschlagen:`, err);
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
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
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
